import { loadConfig, type AppConfig } from './config';
import { ModelRegistry } from './registry';
import { SkillLibrary } from './skills';
import { MediaStore } from './media';
import { ProjectStore } from './projects';
import { JobManager } from './jobs';
import { ffmpegStatus } from './ffmpeg';
import { analyzeScript, autoCast, generatePortrait, renderScene, type Ctx, type Progress } from './pipeline';
import { mergeScenes } from './merge';
import { bindCharacters } from './scriptParser';
import { newId } from './constants';
import type { CharacterItem, Project, ProjectSettings, SceneItem } from './types';

export interface AppContext extends Ctx {
  projects: ProjectStore;
  jobs: JobManager;
  director: Director;
}

export function createContext(config: AppConfig = loadConfig()): AppContext {
  const registry = new ModelRegistry(config);
  const skills = new SkillLibrary(config.skillDirs);
  const media = new MediaStore(config.dataDir);
  const projects = new ProjectStore(config.dataDir);
  const jobs = new JobManager();
  const ctx = { config, registry, skills, media, projects, jobs } as AppContext;
  ctx.director = new Director(ctx);
  return ctx;
}

/**
 * Project-level operations (load → run pipeline step → save). Used by MCP, ACP and the CLI;
 * the web UI holds its own state and calls the stateless pipeline endpoints instead.
 */
export class Director {
  constructor(private ctx: AppContext) {}

  defaults(): Partial<ProjectSettings> {
    const r = this.ctx.registry;
    return { textModel: r.defaultId('text'), imageModel: r.defaultId('image'), videoModel: r.defaultId('video') };
  }

  createProject(init: { name?: string; script?: string; settings?: Partial<ProjectSettings> }): Project {
    return this.ctx.projects.create(init, this.defaults());
  }

  get(id: string) {
    return this.ctx.projects.get(id);
  }

  updateSettings(id: string, patch: Partial<ProjectSettings>): Project {
    const p = this.get(id);
    p.settings = { ...p.settings, ...patch };
    return this.ctx.projects.save(p);
  }

  setScript(id: string, script: string): Project {
    const p = this.get(id);
    p.script = script;
    return this.ctx.projects.save(p);
  }

  async analyze(id: string, onProgress: Progress = () => {}): Promise<{ project: Project; engine: string; warning?: string }> {
    const p = this.get(id);
    onProgress('Đang phân tích kịch bản và tách cảnh...');
    const r = await analyzeScript(this.ctx, {
      script: p.script,
      mode: p.settings.scriptMode,
      skillIds: p.settings.skillIds,
      textModel: p.settings.textModel || undefined,
      characters: p.characters
    });
    p.scenes = r.scenes;
    p.merged = undefined;
    const aspect = this.ctx.skills.compose(p.settings.skillIds).aspectRatio;
    if (aspect) p.settings.aspectRatio = aspect;
    return { project: this.ctx.projects.save(p), engine: r.engine, warning: r.warning };
  }

  async cast(id: string, onProgress: Progress = () => {}): Promise<{ project: Project; warnings: string[] }> {
    const p = this.get(id);
    const r = await autoCast(
      this.ctx,
      {
        script: p.script,
        scenes: p.scenes,
        characters: p.characters,
        skillIds: p.settings.skillIds,
        textModel: p.settings.textModel || undefined,
        imageModel: p.settings.imageModel || undefined
      },
      onProgress
    );
    p.characters = r.characters;
    p.scenes = r.scenes;
    return { project: this.ctx.projects.save(p), warnings: r.warnings };
  }

  async addCharacter(
    id: string,
    args: { name: string; description?: string; imagePath?: string; imageDataUrl?: string; imagePrompt?: string }
  ): Promise<Project> {
    const p = this.get(id);
    let ch: CharacterItem;
    if (args.imagePath || args.imageDataUrl) {
      const image = args.imagePath ? this.ctx.media.importFile(args.imagePath, 'char') : this.ctx.media.saveDataUrl(args.imageDataUrl!, 'char');
      ch = { id: newId('char'), name: args.name, description: args.description, image };
    } else {
      ch = await generatePortrait(this.ctx, {
        spec: { name: args.name, description: args.description, imagePrompt: args.imagePrompt },
        skillIds: p.settings.skillIds,
        imageModel: p.settings.imageModel || undefined
      });
    }
    p.characters = p.characters.filter(c => c.name.toLowerCase() !== ch.name.toLowerCase()).concat(ch);
    p.scenes = bindCharacters(p.scenes, p.characters);
    return this.ctx.projects.save(p);
  }

  updateScene(id: string, sceneNumber: number, patch: Partial<SceneItem>): Project {
    const p = this.get(id);
    const sc = p.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!sc) throw new Error(`Không có cảnh số ${sceneNumber}`);
    const { id: _i, sceneNumber: _n, ...safe } = patch;
    Object.assign(sc, safe);
    return this.ctx.projects.save(p);
  }

  async renderScene(id: string, sceneNumber: number, onProgress: Progress = () => {}): Promise<SceneItem> {
    const p = this.get(id);
    const sc = p.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!sc) throw new Error(`Không có cảnh số ${sceneNumber}`);
    onProgress(`Đang render cảnh ${sceneNumber}: ${sc.title}`);
    try {
      const r = await renderScene(this.ctx, { scene: sc, characters: p.characters, settings: p.settings });
      Object.assign(sc, { status: 'completed', errorMessage: undefined, video: r.video, lastRender: r.lastRender });
    } catch (e) {
      Object.assign(sc, { status: 'error', errorMessage: (e as Error).message });
    }
    // Re-read to avoid clobbering other changes made while rendering.
    const fresh = this.get(id);
    const idx = fresh.scenes.findIndex(s => s.id === sc.id);
    if (idx >= 0) fresh.scenes[idx] = { ...fresh.scenes[idx], status: sc.status, errorMessage: sc.errorMessage, video: sc.video, lastRender: sc.lastRender };
    this.ctx.projects.save(fresh);
    return sc;
  }

  async renderAll(id: string, opts: { onlyMissing?: boolean } = {}, onProgress: Progress = () => {}): Promise<Project> {
    const p = this.get(id);
    const todo = p.scenes.filter(s => !opts.onlyMissing || s.status !== 'completed' || !this.ctx.media.exists(s.video));
    for (const [i, s] of todo.entries()) {
      onProgress(`Render ${i + 1}/${todo.length}: cảnh ${s.sceneNumber} — ${s.title}`);
      await this.renderScene(id, s.sceneNumber);
    }
    return this.get(id);
  }

  async merge(id: string, onProgress: Progress = () => {}): Promise<Project> {
    const p = this.get(id);
    const r = await mergeScenes(
      this.ctx,
      { scenes: p.scenes, resolution: p.settings.resolution, aspectRatio: p.settings.aspectRatio, burnInSubtitles: p.settings.burnInSubtitles },
      onProgress
    );
    p.merged = r.video;
    p.mergedSubtitles = r.subtitles;
    return this.ctx.projects.save(p);
  }

  /** Full pipeline: analyze → (auto cast) → render all → merge. */
  async makeVideo(id: string, onProgress: Progress = () => {}): Promise<{ project: Project; notes: string[] }> {
    const notes: string[] = [];
    const a = await this.analyze(id, onProgress);
    notes.push(`Tách ${a.project.scenes.length} cảnh bằng ${a.engine}`);
    if (a.warning) notes.push(a.warning);
    if (a.project.settings.autoGenerateCharacters) {
      const c = await this.cast(id, onProgress);
      notes.push(`Dàn nhân vật: ${c.project.characters.map(ch => ch.name).join(', ') || '(không có)'}`);
      notes.push(...c.warnings);
    }
    const r = await this.renderAll(id, { onlyMissing: true }, onProgress);
    const failed = r.scenes.filter(s => s.status === 'error');
    failed.forEach(s => notes.push(`Cảnh ${s.sceneNumber} lỗi: ${s.errorMessage}`));
    onProgress('Đang ghép video hoàn chỉnh...');
    const project = await this.merge(id, onProgress);
    return { project, notes };
  }

  async health() {
    return { ffmpeg: await ffmpegStatus(this.ctx.config.ffmpegPath), dataDir: this.ctx.config.dataDir };
  }
}
