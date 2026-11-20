import fs from 'node:fs';
import path from 'node:path';
import type { Project, ProjectSettings } from './types';
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
    return JSON.parse(fs.readFileSync(f, 'utf8'));
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
    fs.writeFileSync(this.file(p.id), JSON.stringify(p, null, 2));
    return p;
  }

  delete(id: string) {
    fs.rmSync(this.file(id), { force: true });
  }
}
