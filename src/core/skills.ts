import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AspectRatio, CameraAngle, SkillInfo } from './types';
import { log } from './log';

export interface ComposedSkills {
  skills: SkillInfo[];
  promptModifier: string;
  negativePrompt: string;
  portraitStyle: string;
  directives: string;
  aspectRatio?: AspectRatio;
  defaultCameraAngle?: CameraAngle;
}

/**
 * Skill Library: every *.md file with YAML front-matter in the skill dirs is a skill.
 * Front-matter carries prompt modifiers; the markdown body is injected as director
 * instructions into the script-analysis prompt. The last dir is the writable "user" dir.
 */
export class SkillLibrary {
  private skills = new Map<string, SkillInfo & { file: string }>();

  constructor(readonly dirs: string[]) {
    this.reload();
  }

  get userDir(): string {
    return this.dirs.length > 1 ? this.dirs[this.dirs.length - 1] : path.join(this.dirs[0], 'user');
  }

  reload() {
    this.skills.clear();
    const dirs = [...new Set([...this.dirs, this.userDir])];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const source: SkillInfo['source'] = dir === this.userDir ? 'user' : 'builtin';
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md') || f.toLowerCase() === 'readme.md') continue;
        const file = path.join(dir, f);
        try {
          const s = parseSkill(fs.readFileSync(file, 'utf8'), path.basename(f, '.md'), source);
          this.skills.set(s.id, { ...s, file });
        } catch (e) {
          log.warn(`Bỏ qua skill lỗi ${file}:`, (e as Error).message);
        }
      }
    }
  }

  list(category?: string): SkillInfo[] {
    return [...this.skills.values()]
      .filter(s => !category || s.category === category)
      .map(({ file: _f, ...s }) => s)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  get(id: string): SkillInfo | undefined {
    const s = this.skills.get(id);
    if (!s) return undefined;
    const { file: _f, ...rest } = s;
    return rest;
  }

  compose(ids: string[]): ComposedSkills {
    const skills = ids.map(id => this.get(id)).filter((s): s is SkillInfo => !!s);
    const join = (vals: (string | undefined)[], sep = ', ') => vals.filter(Boolean).join(sep);
    const last = <K extends keyof SkillInfo>(k: K) => [...skills].reverse().find(s => s[k])?.[k];
    return {
      skills,
      promptModifier: join(skills.map(s => s.promptModifier)),
      negativePrompt: join(skills.map(s => s.negativePrompt)),
      portraitStyle: join(skills.map(s => s.portraitStyle)),
      directives: skills
        .filter(s => s.directives.trim())
        .map(s => `### Skill: ${s.name}\n${s.directives.trim()}`)
        .join('\n\n'),
      aspectRatio: last('aspectRatio') as AspectRatio | undefined,
      defaultCameraAngle: last('defaultCameraAngle') as CameraAngle | undefined
    };
  }

  /** Create or overwrite a user skill. */
  save(skill: Omit<SkillInfo, 'source'>): SkillInfo {
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(skill.id)) throw new Error('id skill chỉ gồm a-z, 0-9, dấu gạch ngang (2-49 ký tự)');
    const existing = this.skills.get(skill.id);
    if (existing && existing.source === 'builtin') throw new Error(`"${skill.id}" là skill có sẵn — hãy chọn id khác`);
    fs.mkdirSync(this.userDir, { recursive: true });
    const { directives, id, ...front } = skill;
    const fm = YAML.stringify(Object.fromEntries(Object.entries({ id, ...front }).filter(([, v]) => v !== undefined && v !== '')));
    fs.writeFileSync(path.join(this.userDir, `${id}.md`), `---\n${fm}---\n\n${directives ?? ''}\n`);
    this.reload();
    return this.get(id)!;
  }

  delete(id: string) {
    const s = this.skills.get(id);
    if (!s) throw new Error('Không tìm thấy skill');
    if (s.source !== 'user') throw new Error('Chỉ xóa được skill do người dùng tạo');
    fs.unlinkSync(s.file);
    this.reload();
  }
}

export function parseSkill(raw: string, fallbackId: string, source: SkillInfo['source']): SkillInfo {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('thiếu front-matter YAML');
  const fm = (YAML.parse(m[1]) ?? {}) as Record<string, any>;
  return {
    id: String(fm.id ?? fallbackId),
    name: String(fm.name ?? fallbackId),
    category: String(fm.category ?? 'style'),
    description: String(fm.description ?? ''),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    promptModifier: fm.promptModifier,
    negativePrompt: fm.negativePrompt,
    aspectRatio: fm.aspectRatio,
    defaultCameraAngle: fm.defaultCameraAngle,
    portraitStyle: fm.portraitStyle,
    directives: m[2].trim(),
    source
  };
}
