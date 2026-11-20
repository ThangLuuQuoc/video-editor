// Pure voice-casting logic (no Node APIs) — shared by the server and the web UI.
import type { CharacterItem, ProjectSettings, SceneItem, VoiceInfo } from './types';
import { mentions } from './scriptParser';

export interface DialogueLine {
  speaker?: string;
  text: string;
}

/** `Mai: "Xin chào"` → { speaker: 'Mai', text: 'Xin chào' }; lines without a speaker keep speaker undefined. */
export function parseDialogueLines(dialogue: string): DialogueLine[] {
  return dialogue
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const m = line.match(/^([^:"“”]{1,40}?)\s*:\s*(.+)$/);
      let speaker: string | undefined;
      let text = line;
      if (m && !/^https?$/i.test(m[1])) {
        speaker = m[1].replace(/\s*[([].*?[)\]]\s*/g, ' ').trim() || undefined; // "Mai (cười)" → "Mai"
        text = m[2];
      }
      text = text.trim().replace(/^["“”'‘]+|["“”'’]+$/g, '').trim();
      return { speaker, text };
    })
    .filter(l => l.text);
}

export interface Traits {
  gender?: 'female' | 'male';
  age?: VoiceInfo['age'];
}

const word = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const ELDER = word([
  'grand(?:ma|mother|pa|father|parents?)', 'granny', 'nana', 'elderly', 'old (?:man|woman|lady)', 'senior', 'aged', '(?:grey|gray|white|silver)[- ]haired',
  'bà nội', 'bà ngoại', 'ông nội', 'ông ngoại', 'bà cụ', 'ông cụ', 'cụ', 'già', 'tóc bạc', 'lớn tuổi', 'cao tuổi', 'ông lão', 'bà lão'
]);
const CHILD = word([
  'child', 'kid', 'boy', 'girl', 'little (?:boy|girl)', 'toddler', 'grandson', 'granddaughter', 'schoolboy', 'schoolgirl',
  'cháu', 'em bé', 'bé', 'cậu bé', 'cô bé', 'đứa trẻ', 'trẻ em', 'học sinh', 'nhóc', 'thằng bé'
]);
const YOUNG = word(['teen(?:ager)?', 'young (?:man|woman|lady)', 'student', 'thiếu niên', 'thiếu nữ', 'sinh viên', 'chàng trai', 'cô gái']);
const FEMALE = word([
  'woman', 'girl', 'female', 'lady', 'grandmother', 'grandma', 'granny', 'mother', 'mom', 'mum', 'she', 'her', 'daughter', 'granddaughter', 'sister', 'wife', 'aunt', 'queen', 'princess', 'actress',
  'bà', 'cô', 'chị', 'mẹ', 'nữ', 'thiếu nữ', 'cô gái', 'cô bé', 'vợ', 'dì', 'mợ', 'thím', 'bà lão', 'bà cụ'
]);
const MALE = word([
  'man', 'boy', 'male', 'gentleman', 'grandfather', 'grandpa', 'father', 'dad', 'he', 'his', 'son', 'grandson', 'brother', 'husband', 'uncle', 'king', 'prince',
  'ông', 'anh', 'chú', 'bác', 'bố', 'cha', 'nam', 'cậu bé', 'chàng trai', 'chồng', 'thằng bé', 'ông lão', 'ông cụ'
]);

function firstIndex(re: RegExp, text: string): number {
  const m = re.exec(text);
  return m ? m.index : -1;
}

/** Guess gender / age from free text (name, role, portrait prompt). Earlier mentions win. */
export function textTraits(text: string): Traits {
  const t = text.normalize('NFC');
  const out: Traits = {};
  const f = firstIndex(FEMALE, t);
  const m = firstIndex(MALE, t);
  if (f >= 0 && (m < 0 || f <= m)) out.gender = 'female';
  else if (m >= 0) out.gender = 'male';
  const years = t.match(/(\d{1,3})[- ]?(?:years?[- ]old|tuổi|yo\b)/i);
  if (years) {
    const n = Number(years[1]);
    out.age = n < 13 ? 'child' : n < 25 ? 'young' : n >= 60 ? 'elder' : 'adult';
  } else if (ELDER.test(t)) out.age = 'elder';
  else if (CHILD.test(t)) out.age = 'child';
  else if (YOUNG.test(t)) out.age = 'young';
  return out;
}

export function characterTraits(c: Pick<CharacterItem, 'name' | 'description' | 'imagePrompt'>): Traits {
  // Name + role first (most specific), then the English portrait prompt fills the gaps.
  const primary = textTraits(`${c.name}. ${c.description ?? ''}`);
  const extra = textTraits(c.imagePrompt ?? '');
  return { gender: primary.gender ?? extra.gender, age: primary.age ?? extra.age };
}

const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
export function detectLang(text: string): 'vi' | 'en' {
  return VI_CHARS.test(text) ? 'vi' : 'en';
}

const AGES = ['child', 'young', 'adult', 'elder'];
function score(v: VoiceInfo, t: Traits, lang: string, used: Set<string>): number {
  let s = 0;
  if (v.lang) s += v.lang.toLowerCase().startsWith(lang) ? 4 : -6;
  else s += 1;
  if (t.gender && v.gender) s += t.gender === v.gender ? 3 : -3;
  if (t.age && v.age) {
    const d = Math.abs(AGES.indexOf(t.age) - AGES.indexOf(v.age));
    s += d === 0 ? 2 : d === 1 ? 1 : -1;
  }
  if (used.has(v.id)) s -= 2;
  return s;
}

export function pickVoice(voices: VoiceInfo[], t: Traits, lang: string, used = new Set<string>()): string {
  let best = voices[0];
  let bestScore = -Infinity;
  for (const v of voices) {
    const sc = score(v, t, lang, used);
    if (sc > bestScore) {
      best = v;
      bestScore = sc;
    }
  }
  return best?.id ?? '';
}

/** Voice for every character: manual choice for this TTS model, else auto-cast (distinct voices where possible). */
export function assignVoices(characters: CharacterItem[], voices: VoiceInfo[], modelId: string, lang: string): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const c of characters) {
    if (c.voice?.model === modelId && c.voice.id && (!voices.length || voices.some(v => v.id === c.voice!.id))) {
      out[c.id] = c.voice.id;
      used.add(c.voice.id);
    }
  }
  for (const c of characters) {
    if (out[c.id]) continue;
    out[c.id] = pickVoice(voices, characterTraits(c), lang, used);
    used.add(out[c.id]);
  }
  return out;
}

export function narratorVoice(settings: Pick<ProjectSettings, 'narratorVoice'>, voices: VoiceInfo[], lang: string, used: Set<string>): string {
  if (settings.narratorVoice && (!voices.length || voices.some(v => v.id === settings.narratorVoice))) return settings.narratorVoice;
  return pickVoice(voices, { age: 'adult' }, lang, used);
}

function actingNotes(t: Traits, description?: string): string {
  const who =
    t.age === 'child' ? 'a young child (about 8 years old), bright and playful'
    : t.age === 'elder' ? `an elderly ${t.gender === 'male' ? 'man' : t.gender === 'female' ? 'woman' : 'person'}, warm, gentle and a little slower`
    : t.age === 'young' ? 'a young adult, lively and natural'
    : 'a natural, friendly adult';
  return `Voice ${who}.${description ? ` Character: ${description}.` : ''}`;
}

export interface PlannedLine extends DialogueLine {
  voice: string;
  characterId?: string;
  instructions: string;
}

/** Decide who says each line and with which voice. */
export function planSceneVoices(
  scene: Pick<SceneItem, 'dialogue' | 'selectedCharacterIds' | 'audioDirection'>,
  characters: CharacterItem[],
  settings: Pick<ProjectSettings, 'narratorVoice' | 'scriptMode'>,
  modelId: string,
  voices: VoiceInfo[],
  lang: string
): { lines: PlannedLine[]; speed: number } {
  const assigned = assignVoices(characters, voices, modelId, lang);
  const used = new Set(Object.values(assigned));
  const inScene = characters.filter(c => scene.selectedCharacterIds.includes(c.id));
  const extras = new Map<string, string>();
  const lines = parseDialogueLines(scene.dialogue).map(l => {
    const name = l.speaker;
    const c = name
      ? characters.find(x => x.name.toLowerCase() === name.toLowerCase()) ?? characters.find(x => mentions(name, x.name) || mentions(x.name, name))
      : inScene.length === 1
        ? inScene[0]
        : undefined;
    let voice: string;
    let notes: string;
    if (c) {
      voice = assigned[c.id];
      notes = actingNotes(characterTraits(c), c.description);
    } else if (name) {
      // Speaker that is not in the cast ("Grandma", "Người bán hàng"): cast a voice from the name itself.
      const t = textTraits(name);
      if (!extras.has(name)) {
        const v = pickVoice(voices, t, lang, used);
        extras.set(name, v);
        used.add(v);
      }
      voice = extras.get(name)!;
      notes = actingNotes(t);
    } else {
      voice = narratorVoice(settings, voices, lang, used);
      notes = 'Calm, clear narrator voice.';
    }
    const direction = scene.audioDirection ? ` Scene mood: ${scene.audioDirection}.` : '';
    return { ...l, voice, characterId: c?.id, instructions: `${notes}${direction}` };
  });
  return { lines, speed: settings.scriptMode === 'educational' ? 0.9 : 1 };
}

/** Small stable hash (FNV-1a) — decides whether a scene's voice track is out of date. */
export function voiceSignature(modelId: string, plan: { lines: PlannedLine[]; speed: number }): string {
  const s = JSON.stringify([modelId, plan.speed, plan.lines.map(l => [l.speaker ?? '', l.text, l.voice])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Should this scene get a TTS voice track? */
export function needsVoice(scene: Pick<SceneItem, 'dialogue'>, settings: Pick<ProjectSettings, 'voiceMode'>, videoHasAudio: boolean): boolean {
  if (!scene.dialogue.trim()) return false;
  const mode = settings.voiceMode ?? 'auto';
  return mode === 'always' || (mode === 'auto' && !videoHasAudio);
}
