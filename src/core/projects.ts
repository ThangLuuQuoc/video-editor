import fs from 'node:fs';
import path from 'node:path';
import type { Project, ProjectSettings, SceneItem } from './types';

/** Scene fields written by render / voice jobs (server-owned). */
export const RENDER_FIELDS = ['status', 'errorMessage', 'video', 'lastRender', 'voice', 'renderRev'] as const;
export function pickRender(s: SceneItem): Partial<SceneItem> {
  const out: Partial<SceneItem> = {};
  for (const k of RENDER_FIELDS) (out as any)[k] = s[k];
  return out;
}
import { DEFAULT_SETTINGS, newId } from './constants';

/** JSON-file project store shared by the web UI, MCP and ACP. */
export class ProjectStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'projects');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error('id project không hợp lệ');
    return path.join(this.dir, `${id}.json`);
  }

  list(): { id: string; name: string; updatedAt: string; scenes: number }[] {
    return fs
      .readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Project;
          return { id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt)) as any;
  }

  get(id: string): Project {
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new Error(`Không tìm thấy project "${id}"`);
    const p = JSON.parse(fs.readFileSync(f, 'utf8')) as Project;
    p.settings = { ...DEFAULT_SETTINGS, ...p.settings }; // projects created before new settings existed
    return p;
  }

  create(init: { name?: string; script?: string; settings?: Partial<ProjectSettings> }, defaults: Partial<ProjectSettings>): Project {
    const now = new Date().toISOString();
    const p: Project = {
      id: newId('prj'),
      name: init.name || `Dự án ${new Date().toLocaleString('vi-VN')}`,
      script: init.script ?? '',
      settings: { ...DEFAULT_SETTINGS, ...defaults, ...(init.settings ?? {}) },
      characters: [],
      scenes: [],
      createdAt: now,
      updatedAt: now
    };
    return this.save(p);
  }

  save(p: Project): Project {
    p.updatedAt = new Date().toISOString();
    try {
      // Revision always grows from what is on disk, whoever saved last (web, MCP, job).
      const cur = JSON.parse(fs.readFileSync(this.file(p.id), 'utf8')) as Project;
      p.revision = Math.max(cur.revision ?? 0, p.revision ?? 0) + 1;
    } catch {
      p.revision = (p.revision ?? 0) + 1;
    }
    const tmp = `${this.file(p.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
    fs.renameSync(tmp, this.file(p.id));
    return p;
  }

  /**
   * Save a project edited by a client (web UI) without clobbering results the server wrote in the
   * meantime: per scene, render fields (status, video, voice…) with a higher `renderRev` on disk
   * win; the merged movie likewise by `mergeRev`. Everything else is last-writer-wins.
   */
  saveFromClient(incoming: Project): Project {
    let cur: Project | undefined;
    try {
      cur = this.get(incoming.id);
    } catch {
      /* new */
    }
    if (cur) {
      const byId = new Map(cur.scenes.map(s => [s.id, s]));
      incoming.scenes = incoming.scenes.map(sc => {
        const server = byId.get(sc.id);
        if (!server || (server.renderRev ?? 0) <= (sc.renderRev ?? 0)) return sc;
        return { ...sc, ...pickRender(server) };
      });
      if ((cur.mergeRev ?? 0) > (incoming.mergeRev ?? 0)) {
        incoming.merged = cur.merged;
        incoming.mergedSubtitles = cur.mergedSubtitles;
        incoming.mergeWarnings = cur.mergeWarnings;
        incoming.mergeRev = cur.mergeRev;
      }
    }
    return this.save(incoming);
  }

  /** All media file names referenced by any project (for media garbage collection). */
  referencedMedia(): Set<string> {
    const out = new Set<string>();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const m of raw.matchAll(/"file":\s*"([^"]+)"/g)) out.add(m[1]);
    }
    return out;
  }

  delete(id: string) {
    fs.rmSync(this.file(id), { force: true });
  }
}
