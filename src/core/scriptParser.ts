import type { CameraAngle, CharacterItem, CharacterSpec, SceneItem, ScriptMode } from './types';
import { newId } from './constants';

/**
 * Rule-based script parser — used offline (mock text model) and as fallback when the LLM fails.
 * Understands the "Cảnh N (Xs): Title / Bối cảnh / Nhân vật / Hành động / Thoại / Âm thanh"
 * format (VI + EN labels) and falls back to one scene per paragraph.
 */

const SCENE_HEADER = /^\s*(?:#+\s*)?(?:cảnh|canh|phân cảnh|scene|shot)\s*(\d+)\s*(?:[([]\s*(\d+(?:\.\d+)?)\s*(?:s|sec|giây|seconds?)?\s*[)\]])?\s*[:\-–.]?\s*(.*)$/i;

const FIELDS: [keyof Fields, RegExp][] = [
  ['setting', /^(?:bối cảnh|boi canh|địa điểm|setting|location)\s*:\s*(.*)$/i],
  ['characters', /^(?:nhân vật|nhan vat|characters?|cast)\s*:\s*(.*)$/i],
  ['action', /^(?:hành động|hanh dong|action|mô tả|description)\s*:\s*(.*)$/i],
  ['dialogue', /^(?:thoại|lời thoại|loi thoai|hội thoại|dialogue|dialog|lines?)\s*:\s*(.*)$/i],
  ['audio', /^(?:âm thanh|am thanh|audio|sound|sfx|nhạc|music)\s*:\s*(.*)$/i],
  ['camera', /^(?:góc quay|goc quay|góc máy|camera|shot type)\s*:\s*(.*)$/i]
];

interface Fields {
  setting: string;
  characters: string;
  action: string;
  dialogue: string;
  audio: string;
  camera: string;
}

interface RawScene {
  num: number;
  duration?: number;
  title: string;
  fields: Fields;
  loose: string[];
}

export function guessCamera(text: string, index: number): CameraAngle {
  const t = text.toLowerCase();
  if (/cận cảnh|close|chân dung|khuôn mặt|đặt bút|ánh mắt/.test(t)) return 'Close-up (Cận cảnh)';
  if (/flycam|drone|trên cao|toàn thành phố|aerial/.test(t)) return 'Drone Aerial (Góc cao)';
  if (/bước đi|chạy|đi dạo|walk|run|follow|bám theo/.test(t)) return index === 0 ? 'Wide Shot (Toàn cảnh)' : 'Tracking Shot (Bám theo)';
  if (/qua vai|over the shoulder/.test(t)) return 'Over-the-shoulder (Qua vai)';
  return index === 0 ? 'Wide Shot (Toàn cảnh)' : 'Medium Shot (Trung cảnh)';
}

function emptyFields(): Fields {
  return { setting: '', characters: '', action: '', dialogue: '', audio: '', camera: '' };
}

function splitNames(s: string): string[] {
  return s
    .split(/[,;&]|\svà\s|\sand\s/i)
    .map(x => x.replace(/\(.*?\)/g, '').trim())
    .filter(x => x.length > 0 && x.length < 40);
}

/** Speakers from lines like `Mai: "..."`. */
export function dialogueSpeakers(dialogue: string): string[] {
  const names = new Set<string>();
  for (const line of dialogue.split(/\n/)) {
    const m = line.match(/^\s*([^:"“]{1,30}?)\s*:\s*["“']/);
    if (m) names.add(m[1].trim());
  }
  return [...names];
}

export function parseScriptRules(script: string, mode: ScriptMode): SceneItem[] {
  const lines = script.split(/\r?\n/);
  const raws: RawScene[] = [];
  let cur: RawScene | null = null;
  let lastField: keyof Fields | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = line.match(SCENE_HEADER);
    if (h) {
      cur = { num: Number(h[1]), duration: h[2] ? Number(h[2]) : undefined, title: h[3].trim(), fields: emptyFields(), loose: [] };
      raws.push(cur);
      lastField = null;
      continue;
    }
    if (!cur) {
      cur = { num: 1, title: '', fields: emptyFields(), loose: [] };
      raws.push(cur);
    }
    const field = FIELDS.find(([, re]) => re.test(line));
    if (field) {
      lastField = field[0];
      const value = line.match(field[1])![1].trim();
      cur.fields[lastField] = cur.fields[lastField] ? `${cur.fields[lastField]}\n${value}` : value;
    } else if (lastField === 'dialogue' || /^[^:]{1,30}:\s*["“]/.test(line)) {
      lastField = 'dialogue';
      cur.fields.dialogue = cur.fields.dialogue ? `${cur.fields.dialogue}\n${line}` : line;
    } else if (lastField) {
      cur.fields[lastField] += ` ${line}`;
    } else {
      cur.loose.push(line);
    }
  }

  // Unstructured script (no headers, no fields): one scene per paragraph.
  const structured = raws.some(r => Object.values(r.fields).some(Boolean)) || raws.length > 1;
  const blocks: RawScene[] = structured
    ? raws
    : script
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 10)
        .map((p, i) => ({ num: i + 1, title: '', fields: { ...emptyFields(), action: p }, loose: [] }));

  return blocks.map((r, i) => {
    const f = r.fields;
    const action = f.action || r.loose.join(' ');
    const dialogue = f.dialogue.trim();
    const names = [...new Set([...splitNames(f.characters), ...dialogueSpeakers(dialogue)])];
    const descParts = [action, f.setting && `Bối cảnh: ${f.setting}`].filter(Boolean);
    return {
      id: newId('sc'),
      sceneNumber: i + 1,
      title: r.title || `Cảnh ${i + 1}`,
      promptDescription: descParts.join('. ') || r.title || 'Cinematic scene',
      action,
      setting: f.setting,
      cameraAngle: f.camera ? guessCamera(f.camera, i) : guessCamera(`${r.title} ${action}`, i),
      durationSeconds: clampDuration(r.duration ?? 5),
      dialogue,
      audioDirection:
        f.audio ||
        (mode === 'educational'
          ? 'Slow, clear, beginner-friendly pronunciation with accurate lip-sync'
          : 'Giọng nói tự nhiên, rõ ràng, khẩu hình khớp câu thoại'),
      characterNames: names,
      selectedCharacterIds: [],
      status: 'idle'
    } satisfies SceneItem;
  });
}

export function clampDuration(n: number): number {
  return Math.min(Math.max(Math.round(Number(n) || 5), 2), 20);
}

/** Characters from "Nhân vật:" lines and dialogue speakers. */
export function extractCharactersRules(script: string): CharacterSpec[] {
  const scenes = parseScriptRules(script, 'strict');
  const seen = new Map<string, CharacterSpec>();
  for (const s of scenes) {
    for (const n of s.characterNames) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      const desc = s.action.match(new RegExp(`${escapeRe(n)}\\s*\\(([^)]+)\\)`, 'i'))?.[1];
      seen.set(key, {
        name: n,
        description: desc ?? `Nhân vật trong ${s.title}`,
        imagePrompt: `${n}${desc ? `, ${desc}` : ''}, front-facing character portrait, clear facial features, neutral lighting`
      });
    }
  }
  return [...seen.values()].slice(0, 6);
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive, Unicode-aware match ("An" must not match "Lan" or "Anh"). */
export function mentions(text: string | undefined, name: string): boolean {
  if (!text || !name.trim()) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name.trim().normalize('NFC'))}($|[^\\p{L}\\p{N}])`, 'iu');
  return re.test(text.normalize('NFC'));
}

/**
 * Bind characters to scenes by name. Unlike the Flow version this never falls back to
 * "first character" — a landscape shot with no characters keeps no references.
 */
export function bindCharacters(scenes: SceneItem[], characters: CharacterItem[]): SceneItem[] {
  return scenes.map(sc => {
    const ids = characters
      .filter(c => {
        const names = sc.characterNames ?? [];
        const byList = names.some(n => n.toLowerCase() === c.name.toLowerCase() || mentions(n, c.name) || mentions(c.name, n));
        const bySpeaker = dialogueSpeakers(sc.dialogue).some(sp => sp.toLowerCase() === c.name.toLowerCase());
        return byList || bySpeaker || mentions(sc.action, c.name);
      })
      .map(c => c.id);
    return { ...sc, selectedCharacterIds: ids.length ? ids : sc.selectedCharacterIds.filter(id => characters.some(c => c.id === id)) };
  });
}
