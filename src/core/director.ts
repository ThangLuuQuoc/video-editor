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
import { generateSceneVoice, projectLang, voicePlanFor } from './voice';
import { needsVoice } from './voicePlan';
import { CanceledError, isCanceled, throwIfAborted } from './providers/base';
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

/** A scene is addressed by number (MCP / ACP: "cảnh 3") or by id (web UI). */
export type SceneRef = number | string;

/**
 * Project-level operations (load → run pipeline step → save). Used by the web UI (as server jobs),
 * MCP, ACP and the CLI, so every long-running step survives a closed browser tab.
 */
export class Director {
  constructor(private ctx: AppContext) {}

  defaults(): Partial<ProjectSettings> {
    const r = this.ctx.registry;
    return { textModel: r.defaultId('text'), imageModel: r.defaultId('image'), videoModel: r.defaultId('video'), ttsModel: r.defaultId('tts') };
  }

  createProject(init: { name?: string; script?: string; settings?: Partial<ProjectSettings> }): Project {
    return this.ctx.projects.create(init, this.defaults());
  }

  get(id: string) {
    return this.ctx.projects.get(id);
  }

  private scene(p: Project, ref: SceneRef): SceneItem {
    const sc = typeof ref === 'number' ? p.scenes.find(s => s.sceneNumber === ref) : p.scenes.find(s => s.id === ref);
    if (!sc) throw new Error(`Không có cảnh ${typeof ref === 'number' ? `số ${ref}` : ref}`);
    return sc;
  }

  /** Re-read the project and apply render-owned fields to one scene (never clobbers concurrent edits). */
  private patchRender(id: string, sceneId: string, patch: Partial<SceneItem>): SceneItem | undefined {
    const fresh = this.get(id);
    const sc = fresh.scenes.find(s => s.id === sceneId);
    if (!sc) return undefined;
    Object.assign(sc, patch, { renderRev: (sc.renderRev ?? 0) + 1 });
    this.ctx.projects.save(fresh);
    return sc;
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
    p.mergedSubtitles = undefined;
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

  updateScene(id: string, ref: SceneRef, patch: Partial<SceneItem>): Project {
    const p = this.get(id);
    const sc = this.scene(p, ref);
    const { id: _i, sceneNumber: _n, renderRev: _r, ...safe } = patch;
    Object.assign(sc, safe);
    return this.ctx.projects.save(p);
  }

  // ---- voice ------------------------------------------------------------------------------

  /** Does this scene need a TTS track, given the video model it was (or will be) rendered with? */
  sceneNeedsVoice(p: Project, sc: SceneItem): boolean {
    const vid = sc.lastRender?.model || p.settings.videoModel || this.ctx.registry.defaultId('video');
    const m = this.ctx.registry.find('video', vid);
    return needsVoice(sc, p.settings, m?.supportsAudio !== false);
  }

  /** Is the scene's voice track missing or stale (dialogue / voices / TTS model changed)? */
  async voiceStale(p: Project, sc: SceneItem): Promise<boolean> {
    if (!sc.voice || !this.ctx.media.exists(sc.voice.audio)) return true;
    try {
      const { signature } = await voicePlanFor(this.ctx, { scene: sc, characters: p.characters, settings: p.settings, lang: projectLang(p.scenes) });
      return signature !== sc.voice.signature;
    } catch {
      return false; // no TTS available → keep what we have
    }
  }

  async voiceScene(id: string, ref: SceneRef, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<SceneItem> {
    const p = this.get(id);
    const sc = this.scene(p, ref);
    const voice = await generateSceneVoice(
      this.ctx,
      { scene: sc, characters: p.characters, settings: p.settings, lang: projectLang(p.scenes), signal },
      onProgress
    );
    return this.patchRender(id, sc.id, { voice }) ?? { ...sc, voice };
  }

  // ---- render -----------------------------------------------------------------------------

  async renderScene(id: string, ref: SceneRef, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<SceneItem> {
    const p = this.get(id);
    const sc = this.scene(p, ref);
    const before = { status: sc.status, errorMessage: sc.errorMessage };
    this.patchRender(id, sc.id, { status: 'generating', errorMessage: undefined });
    onProgress(`Đang render cảnh ${sc.sceneNumber}: ${sc.title}`);
    try {
      const r = await renderScene(this.ctx, { scene: sc, characters: p.characters, settings: p.settings, signal }, onProgress);
      let updated = this.patchRender(id, sc.id, { status: 'completed', errorMessage: undefined, video: r.video, lastRender: r.lastRender })!;
      // Voice-over for models without audio. A TTS failure must not throw away a paid video.
      const fresh = this.get(id);
      if (updated && this.sceneNeedsVoice(fresh, updated) && (await this.voiceStale(fresh, updated))) {
        try {
          updated = await this.voiceScene(id, sc.id, onProgress, signal);
        } catch (e) {
          if (isCanceled(e, signal)) throw e;
          const notes = [...(updated.lastRender?.notes ?? []), `Lồng tiếng lỗi: ${(e as Error).message.slice(0, 200)}`];
          updated = this.patchRender(id, sc.id, { lastRender: { ...updated.lastRender!, notes } }) ?? updated;
        }
      }
      return updated;
    } catch (e) {
      if (isCanceled(e, signal)) {
        // Back to how it was (keeps a previous video if there was one).
        this.patchRender(id, sc.id, { status: before.status === 'generating' ? (sc.video ? 'completed' : 'idle') : before.status, errorMessage: before.errorMessage });
        throw new CanceledError();
      }
      return this.patchRender(id, sc.id, { status: 'error', errorMessage: (e as Error).message }) ?? sc;
    }
  }

  async renderAll(
    id: string,
    opts: { onlyMissing?: boolean; thenMerge?: boolean } = {},
    onProgress: Progress = () => {},
    signal?: AbortSignal
  ): Promise<Project> {
    const p = this.get(id);
    const todo = p.scenes.filter(s => !opts.onlyMissing || s.status !== 'completed' || !this.ctx.media.exists(s.video));
    for (const [i, s] of todo.entries()) {
      throwIfAborted(signal);
      const still = this.get(id).scenes.find(x => x.id === s.id);
      if (!still) continue; // deleted meanwhile
      await this.renderScene(id, s.id, m => onProgress(`[${i + 1}/${todo.length}] ${m}`), signal);
    }
    if (opts.thenMerge) return this.merge(id, onProgress, signal);
    return this.get(id);
  }

  async merge(id: string, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<Project> {
    let p = this.get(id);
    const warnings: string[] = [];
    // Make sure every completed scene that needs a voice has an up-to-date one (cheap vs. video).
    for (const sc of p.scenes) {
      if (sc.status !== 'completed' || !this.sceneNeedsVoice(p, sc) || !(await this.voiceStale(p, sc))) continue;
      try {
        await this.voiceScene(id, sc.id, onProgress, signal);
      } catch (e) {
        if (isCanceled(e, signal)) throw e;
        warnings.push(`Cảnh ${sc.sceneNumber}: lồng tiếng lỗi (${(e as Error).message.slice(0, 160)})`);
      }
    }
    p = this.get(id);
    const scenes = p.scenes.map(sc => (this.sceneNeedsVoice(p, sc) ? sc : { ...sc, voice: undefined }));
    const voiced = scenes.filter(sc => sc.voice);
    if (voiced.length) {
      const lang = projectLang(p.scenes);
      const voices = this.ctx.registry.voices(voiced[0].voice!.model);
      if (voices.length && voices.every(v => v.lang && !v.lang.toLowerCase().startsWith(lang)))
        warnings.push(
          `Thoại là ${lang === 'vi' ? 'tiếng Việt' : 'tiếng Anh'} nhưng model TTS "${voiced[0].voice!.model}" không có giọng ngôn ngữ này — hãy chọn model đa ngôn ngữ (ElevenLabs, OpenAI) hoặc cài giọng ${lang === 'vi' ? 'tiếng Việt' : 'tiếng Anh'} cho hệ điều hành.`
        );
    }
    const r = await mergeScenes(
      this.ctx,
      { scenes, resolution: p.settings.resolution, aspectRatio: p.settings.aspectRatio, burnInSubtitles: p.settings.burnInSubtitles, signal },
      onProgress
    );
    const fresh = this.get(id);
    fresh.merged = r.video;
    fresh.mergedSubtitles = r.subtitles;
    fresh.mergeWarnings = [...warnings, ...r.warnings];
    fresh.mergeRev = (fresh.mergeRev ?? 0) + 1;
    return this.ctx.projects.save(fresh);
  }

  /** Full pipeline: analyze → (auto cast) → render all → merge. */
  async makeVideo(id: string, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<{ project: Project; notes: string[] }> {
    const notes: string[] = [];
    const a = await this.analyze(id, onProgress);
    notes.push(`Tách ${a.project.scenes.length} cảnh bằng ${a.engine}`);
    if (a.warning) notes.push(a.warning);
    if (a.project.settings.autoGenerateCharacters) {
      throwIfAborted(signal);
      const c = await this.cast(id, onProgress);
      notes.push(`Dàn nhân vật: ${c.project.characters.map(ch => ch.name).join(', ') || '(không có)'}`);
      notes.push(...c.warnings);
    }
    const r = await this.renderAll(id, { onlyMissing: true }, onProgress, signal);
    r.scenes.filter(s => s.status === 'error').forEach(s => notes.push(`Cảnh ${s.sceneNumber} lỗi: ${s.errorMessage}`));
    r.scenes.flatMap(s => (s.lastRender?.notes ?? []).map(n => `Cảnh ${s.sceneNumber}: ${n}`)).forEach(n => notes.push(n));
    onProgress('Đang ghép video hoàn chỉnh...');
    const project = await this.merge(id, onProgress, signal);
    notes.push(...(project.mergeWarnings ?? []));
    return { project, notes };
  }

  /** Delete media files that no project references anymore. */
  cleanupMedia(dryRun = false): { files: number; bytes: number } {
    const r = this.ctx.media.gc(this.ctx.projects.referencedMedia(), { dryRun });
    return { files: r.files.length, bytes: r.bytes };
  }

  async health() {
    return { ffmpeg: await ffmpegStatus(this.ctx.config.ffmpegPath), dataDir: this.ctx.config.dataDir };
  }
}
