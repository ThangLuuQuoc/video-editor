import type { AppConfig, ModelConfig } from './config';
import type { ModelRegistry } from './registry';
import type { SkillLibrary } from './skills';
import type { MediaStore } from './media';
import type { MediaRef } from './providers/base';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AspectRatio, CharacterItem, CharacterSpec, MediaAsset, ProjectSettings, SceneItem, ScriptMode, VideoResolution } from './types';
import { CAMERA_ANGLES, newId } from './constants';
import { extractJson } from './json';
import { bindCharacters, clampDuration, extractCharactersRules, mentions, parseScriptRules } from './scriptParser';
import { MOCK_TEXT_ERROR } from './providers/mock';
import { log } from './log';
import { runFfmpeg } from './ffmpeg';
import { throwIfAborted } from './providers/base';

export interface Ctx {
  config: AppConfig;
  registry: ModelRegistry;
  skills: SkillLibrary;
  media: MediaStore;
}

export type Progress = (msg: string) => void;
const noop: Progress = () => {};

const MODE_INSTRUCTIONS: Record<ScriptMode, string> = {
  educational:
    'Chế độ: EDUCATIONAL (Học ngoại ngữ/hội thoại). Rất chú trọng phát âm chậm, rõ ràng từng từ, khẩu hình lip-sync chuẩn xác, giữ nguyên 100% câu thoại ngoại ngữ.',
  strict:
    'Chế độ: STRICT (Bám sát 100% kịch bản). Nếu kịch bản đã ghi Cảnh 1, Cảnh 2... hoặc số giây cụ thể, BẮT BUỘC giữ đúng số lượng cảnh, số giây và giữ NGUYÊN VĂN 100% lời thoại, không thêm bớt hay tóm tắt.',
  cinematic: 'Chế độ: CINEMATIC (Sáng tạo điện ảnh). Tối ưu góc quay, mô tả chuyển động camera và bối cảnh đậm chất điện ảnh.'
};

// ---------------------------------------------------------------------------------------------
// 1. Script analysis
// ---------------------------------------------------------------------------------------------

export async function analyzeScript(
  ctx: Ctx,
  args: { script: string; mode: ScriptMode; skillIds: string[]; textModel?: string; characters?: CharacterItem[] }
): Promise<{ scenes: SceneItem[]; engine: string; warning?: string }> {
  const { script, mode } = args;
  if (!script.trim()) throw new Error('Kịch bản trống');
  const composed = ctx.skills.compose(args.skillIds);
  const characters = args.characters ?? [];

  const prompt = `Bạn là đạo diễn kịch bản điện ảnh và biên kịch cao cấp. Hãy phân tích kịch bản sau thành danh sách phân cảnh (scenes) cho quy trình sản xuất video AI.
${MODE_INSTRUCTIONS[mode]}
${composed.directives ? `\nHƯỚNG DẪN ĐẠO DIỄN TỪ SKILL LIBRARY (áp dụng khi viết promptDescription, cameraAngle, audioDirection):\n${composed.directives}\n` : ''}
Kịch bản đầu vào:
"""
${script}
"""
QUY TẮC BẮT BUỘC:
1. Nếu kịch bản đã chia cảnh ("Cảnh 1 (5s)", "Scene 2"...), TUÂN THỦ CHÍNH XÁC số cảnh và lấy số giây trong ngoặc làm "durationSeconds" (không ghi thì 4–8 giây).
2. "dialogue": lấy NGUYÊN VĂN toàn bộ lời thoại trong cảnh, giữ ngôn ngữ gốc, không dịch/tóm tắt/bỏ sót. Nhiều người nói thì mỗi dòng dạng 'Tên: "câu thoại"'.
3. "characterNames": tên các nhân vật xuất hiện hoặc nói trong cảnh (đúng như tên trong kịch bản).
4. "audioDirection": chỉ dẫn giọng nói, khẩu hình và âm thanh môi trường.
5. "promptDescription": TIẾNG ANH, mô tả hình ảnh chi tiết: ai làm gì, biểu cảm, đang nói với ai, bối cảnh, ánh sáng, chuyển động máy quay.
6. "cameraAngle" chọn một trong: ${CAMERA_ANGLES.map(a => `"${a}"`).join(' | ')}.
Chỉ trả về MỘT mảng JSON hợp lệ, không markdown, không giải thích:
[{"title":"...","promptDescription":"...","action":"...","setting":"...","cameraAngle":"...","durationSeconds":5,"dialogue":"...","audioDirection":"...","characterNames":["..."]}]`;

  try {
    const { model, provider } = ctx.registry.resolve('text', args.textModel);
    const text = await provider.text!(model, {
      prompt,
      system: 'You are an elite cinema director and dialogue supervisor. Output a raw valid JSON array only and never omit any spoken dialogue.'
    });
    const parsed = extractJson<any[]>(text);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('AI trả về danh sách cảnh rỗng');
    const scenes: SceneItem[] = parsed.map((item, idx) => ({
      id: newId('sc'),
      sceneNumber: idx + 1,
      // Some models echo the "Cảnh 1 (5s):" header into the title — strip it.
      title: String(item.title || '').replace(/^\s*(?:cảnh|scene|phân cảnh)\s*\d+\s*(?:\([^)]*\))?\s*[:\-–.]\s*/i, '').trim() || `Cảnh ${idx + 1}`,
      promptDescription: String(item.promptDescription || item.action || 'Cinematic scene'),
      action: String(item.action || ''),
      setting: String(item.setting || ''),
      cameraAngle: CAMERA_ANGLES.includes(item.cameraAngle) ? item.cameraAngle : composed.defaultCameraAngle ?? 'Medium Shot (Trung cảnh)',
      durationSeconds: clampDuration(item.durationSeconds),
      dialogue: String(item.dialogue || ''),
      audioDirection: String(item.audioDirection || ''),
      characterNames: Array.isArray(item.characterNames) ? item.characterNames.map(String) : [],
      selectedCharacterIds: [],
      status: 'idle'
    }));
    return { scenes: bindCharacters(scenes, characters), engine: model.id };
  } catch (err) {
    const msg = (err as Error).message;
    const isMock = msg === MOCK_TEXT_ERROR;
    if (!isMock) log.warn('Phân tích bằng LLM thất bại, dùng parser theo luật:', msg);
    const scenes = parseScriptRules(script, mode);
    if (composed.defaultCameraAngle) scenes.forEach((s, i) => i > 0 && (s.cameraAngle = composed.defaultCameraAngle!));
    return {
      scenes: bindCharacters(scenes, characters),
      engine: 'rules',
      warning: isMock ? undefined : `LLM lỗi (${msg.slice(0, 160)}) — đã dùng bộ tách cảnh theo luật`
    };
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Cast: extract characters + portraits
// ---------------------------------------------------------------------------------------------

export async function extractCharacterSpecs(ctx: Ctx, args: { script: string; textModel?: string }): Promise<CharacterSpec[]> {
  const prompt = `Dựa vào kịch bản sau, xác định TẤT CẢ nhân vật có tên, vai trò hoặc lời thoại (tối đa 6 nhân vật quan trọng nhất):
"""
${args.script}
"""
Chỉ trả về một mảng JSON:
[{"name":"Tên đúng như trong kịch bản","imagePrompt":"Detailed ENGLISH portrait description: age, gender, ethnicity, face, hair, outfit, distinctive features","description":"Vai diễn ngắn gọn (tiếng Việt)"}]`;
  try {
    const { model, provider } = ctx.registry.resolve('text', args.textModel);
    const text = await provider.text!(model, { prompt, system: 'You extract characters from scripts and output a valid JSON array only.' });
    const arr = extractJson<any[]>(text);
    if (!Array.isArray(arr)) throw new Error('not array');
    return arr
      .filter(c => c?.name)
      .map(c => ({ name: String(c.name), imagePrompt: c.imagePrompt ? String(c.imagePrompt) : undefined, description: c.description ? String(c.description) : undefined }));
  } catch (err) {
    if ((err as Error).message !== MOCK_TEXT_ERROR) log.warn('Trích nhân vật bằng LLM thất bại, dùng luật:', (err as Error).message);
    return extractCharactersRules(args.script);
  }
}

export async function generatePortrait(
  ctx: Ctx,
  args: { spec: CharacterSpec; skillIds: string[]; imageModel?: string }
): Promise<CharacterItem> {
  const composed = ctx.skills.compose(args.skillIds);
  const { model, provider } = ctx.registry.resolve('image', args.imageModel);
  const prompt = [
    args.spec.imagePrompt || `${args.spec.name}, ${args.spec.description ?? ''}`,
    'character reference sheet portrait, front view, head and shoulders, consistent identity, plain neutral background, sharp focus',
    composed.portraitStyle || composed.promptModifier
  ]
    .filter(Boolean)
    .join(', ');
  const out = await provider.image!(model, { prompt, negativePrompt: composed.negativePrompt || undefined, aspectRatio: '1:1' });
  const image = await ctx.media.saveGenerated(out, 'image/png', 'char');
  return { id: newId('char'), name: args.spec.name, description: args.spec.description, imagePrompt: args.spec.imagePrompt, image };
}

export async function autoCast(
  ctx: Ctx,
  args: { script: string; scenes: SceneItem[]; characters: CharacterItem[]; skillIds: string[]; textModel?: string; imageModel?: string },
  onProgress: Progress = noop
): Promise<{ characters: CharacterItem[]; scenes: SceneItem[]; warnings: string[] }> {
  onProgress('Đang xác định các nhân vật trong kịch bản...');
  const specs = await extractCharacterSpecs(ctx, { script: args.script, textModel: args.textModel });
  const cast = [...args.characters];
  const warnings: string[] = [];
  for (const spec of specs) {
    const exists = cast.some(c => c.name.toLowerCase() === spec.name.toLowerCase() || mentions(c.name, spec.name) || mentions(spec.name, c.name));
    if (exists) continue;
    onProgress(`Đang vẽ chân dung: ${spec.name}...`);
    try {
      cast.push(await generatePortrait(ctx, { spec, skillIds: args.skillIds, imageModel: args.imageModel }));
    } catch (e) {
      warnings.push(`${spec.name}: ${(e as Error).message}`);
    }
  }
  return { characters: cast, scenes: bindCharacters(args.scenes, cast), warnings };
}

// ---------------------------------------------------------------------------------------------
// 3. Scene rendering
// ---------------------------------------------------------------------------------------------

export function snapVideoParams(
  m: ModelConfig,
  durationSeconds: number,
  resolution: VideoResolution,
  aspectRatio: AspectRatio
): { durationSeconds: number; resolution: VideoResolution; aspectRatio: AspectRatio } {
  let d = durationSeconds || 5;
  if (m.durations?.length) d = m.durations.reduce((best, cur) => (Math.abs(cur - d) < Math.abs(best - d) ? cur : best));
  else d = Math.min(Math.max(d, m.minDuration ?? 2), m.maxDuration ?? 20);
  const res = !m.resolutions?.length || m.resolutions.includes(resolution) ? resolution : m.resolutions[m.resolutions.length - 1];
  const ar = !m.aspectRatios?.length || m.aspectRatios.includes(aspectRatio) ? aspectRatio : m.aspectRatios[0];
  return { durationSeconds: d, resolution: res, aspectRatio: ar };
}

// ---------------------------------------------------------------------------------------------
// 3a. Character references: direct images, a composite "character sheet", or a keyframe
// ---------------------------------------------------------------------------------------------

export interface RefLayout {
  /** Sent as individual reference images. */
  direct: CharacterItem[];
  /** Composited side by side into ONE extra image (when the model accepts fewer images than characters). */
  sheet: CharacterItem[];
  /** How the prompt refers to each character's reference. */
  labels: Record<string, string>;
}

export interface RefPlan extends RefLayout {
  mode: 'none' | 'direct' | 'sheet' | 'keyframe';
  chars: CharacterItem[];
  keyframeModel?: ModelConfig;
  notes: string[];
}

const PANEL: Record<number, string[]> = { 2: ['left', 'right'], 3: ['left', 'middle', 'right'] };

export function layoutRefs(chars: CharacterItem[], max: number): RefLayout {
  const labels: Record<string, string> = {};
  if (chars.length <= max) {
    chars.forEach((c, i) => (labels[c.id] = `reference image ${i + 1}`));
    return { direct: chars, sheet: [], labels };
  }
  const direct = chars.slice(0, Math.max(0, max - 1));
  const sheet = chars.slice(direct.length);
  direct.forEach((c, i) => (labels[c.id] = `reference image ${i + 1}`));
  const n = direct.length + 1;
  sheet.forEach((c, k) => {
    const pos = PANEL[sheet.length]?.[k] ?? `panel ${k + 1} from the left`;
    labels[c.id] = `the ${pos} portrait in reference image ${n}`;
  });
  return { direct, sheet, labels };
}

function isMockModel(ctx: Ctx, m: ModelConfig) {
  return ctx.config.providers[m.provider]?.type === 'mock';
}

/** Image model used to stage the opening frame for image-to-video models (needs multi-image input). */
export function keyframeModelFor(ctx: Ctx, settings: Pick<ProjectSettings, 'keyframeModel'>): ModelConfig | undefined {
  if (settings.keyframeModel === 'off') return undefined;
  const ids = settings.keyframeModel ? [settings.keyframeModel] : [ctx.config.defaults.keyframe, ...ctx.config.models.image.map(m => m.id)];
  for (const id of ids) {
    const m = ctx.registry.find('image', id);
    if (m && (m.maxReferenceImages ?? 0) > 0 && !isMockModel(ctx, m) && ctx.registry.isAvailable('image', m.id)) return m;
  }
  return undefined;
}

export function planReferences(ctx: Ctx, model: ModelConfig, scene: SceneItem, characters: CharacterItem[], settings: ProjectSettings): RefPlan {
  const mock = isMockModel(ctx, model);
  const bound = characters.filter(c => scene.selectedCharacterIds.includes(c.id) && c.image && ctx.media.exists(c.image));
  const notes: string[] = [];
  const chars = bound.filter(c => mock || c.image!.mimeType !== 'image/svg+xml');
  const svg = bound.filter(c => !chars.includes(c));
  if (svg.length) notes.push(`Ảnh của ${svg.map(c => c.name).join(', ')} là avatar mock (SVG) — không gửi được tới model thật, hãy vẽ lại bằng model ảnh thật hoặc tải ảnh lên`);
  const none: RefPlan = { mode: 'none', chars, direct: [], sheet: [], labels: {}, notes };
  if (!chars.length) return none;
  const max = mock ? Infinity : model.maxReferenceImages ?? 0;
  if (max <= 0) {
    notes.push(`${model.label ?? model.id} không nhận ảnh tham chiếu — nhân vật chỉ được mô tả bằng chữ`);
    return none;
  }
  if (!mock && model.referenceMode === 'first-frame') {
    const km = keyframeModelFor(ctx, settings);
    if (!km) {
      notes.push(
        `${model.label ?? model.id} dùng ảnh làm KHUNG HÌNH ĐẦU, nhưng chưa có model ảnh nhận ảnh tham chiếu (Nano Banana, gpt-image…) để dựng khung hình có nhân vật → nhân vật chỉ được mô tả bằng chữ`
      );
      return none;
    }
    const labels: Record<string, string> = {};
    chars.forEach(c => (labels[c.id] = 'as shown in the opening frame'));
    return { mode: 'keyframe', chars, direct: chars, sheet: [], labels, keyframeModel: km, notes };
  }
  const layout = layoutRefs(chars, max);
  if (layout.sheet.length)
    notes.push(`Cảnh có ${chars.length} nhân vật nhưng model chỉ nhận ${max} ảnh → ghép ${layout.sheet.map(c => c.name).join(' + ')} thành 1 ảnh tham chiếu`);
  return { mode: layout.sheet.length ? 'sheet' : 'direct', chars, ...layout, notes };
}

function toRef(buffer: Buffer, mimeType: string): MediaRef {
  return { buffer, mimeType, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
}

const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Put several portraits side by side (same cell size, white padding) → one PNG. */
export async function compositeSheet(ctx: Ctx, chars: CharacterItem[], signal?: AbortSignal): Promise<MediaRef> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-sheet-'));
  try {
    const inputs = chars.map((c, i) => {
      const f = `in${i}.${IMG_EXT[c.image!.mimeType] ?? 'png'}`;
      fs.writeFileSync(path.join(dir, f), ctx.media.readBuffer(c.image!));
      return f;
    });
    const cells = inputs.map(
      (_f, i) => `[${i}:v]scale=512:640:force_original_aspect_ratio=decrease,pad=532:660:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=rgb24[p${i}]`
    );
    const filter = `${cells.join(';')};${inputs.map((_f, i) => `[p${i}]`).join('')}hstack=inputs=${inputs.length}[out]`;
    const r = await runFfmpeg(ctx.config.ffmpegPath, [...inputs.flatMap(f => ['-i', f]), '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', 'sheet.png'], dir, signal);
    if (r.code !== 0) throw new Error(`Ghép ảnh nhân vật lỗi: ${r.stderr.slice(0, 300)}`);
    return toRef(fs.readFileSync(path.join(dir, 'sheet.png')), 'image/png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function buildRefs(ctx: Ctx, layout: RefLayout, signal?: AbortSignal): Promise<MediaRef[]> {
  const refs = layout.direct.map(c => toRef(ctx.media.readBuffer(c.image!), c.image!.mimeType));
  if (layout.sheet.length === 1) refs.push(toRef(ctx.media.readBuffer(layout.sheet[0].image!), layout.sheet[0].image!.mimeType));
  else if (layout.sheet.length > 1) refs.push(await compositeSheet(ctx, layout.sheet, signal));
  return refs;
}

// ---------------------------------------------------------------------------------------------
// 3b. Prompts
// ---------------------------------------------------------------------------------------------

function characterLine(bound: CharacterItem[], labels: Record<string, string>): string {
  const anyRef = bound.some(c => labels[c.id]);
  return `Characters: ${bound
    .map(c => `${c.name}${c.description ? ` (${c.description})` : ''}${labels[c.id] ? ` — ${labels[c.id]}` : ''}`)
    .join('; ')}.${anyRef ? ' Keep faces, hairstyles and outfits identical to the references.' : ''}`;
}

export function buildScenePrompt(
  ctx: Ctx,
  scene: SceneItem,
  characters: CharacterItem[],
  settings: ProjectSettings,
  model: ModelConfig,
  plan: RefPlan = planReferences(ctx, model, scene, characters, settings)
): { prompt: string; negativePrompt?: string; plan: RefPlan } {
  const supportsAudio = model.supportsAudio !== false;
  const composed = ctx.skills.compose(settings.skillIds);
  const bound = characters.filter(c => scene.selectedCharacterIds.includes(c.id));
  const parts: string[] = [scene.promptDescription];
  if (scene.setting && !scene.promptDescription.includes(scene.setting)) parts.push(`Setting: ${scene.setting}.`);
  if (bound.length) parts.push(characterLine(bound, plan.labels));
  parts.push(`Camera shot: ${scene.cameraAngle}.`);
  if (scene.dialogue.trim()) {
    if (supportsAudio) {
      parts.push(
        `Spoken dialogue (exact words, original language, accurate lip-sync): ${scene.dialogue.trim().replace(/\n+/g, ' ')}. Voice & audio: ${
          scene.audioDirection || 'clear natural speech, soft ambient background that never overpowers voices'
        }.`
      );
    } else {
      parts.push('The characters are talking with natural, expressive mouth movements. No on-screen text.');
    }
  } else if (supportsAudio && scene.audioDirection) {
    parts.push(`Audio: ${scene.audioDirection}.`);
  }
  if (settings.scriptMode === 'educational') {
    parts.push('Characters speak slowly and crystal-clearly with distinct pronunciation and accurate lip movement.');
  }
  if (composed.promptModifier) parts.push(`Visual style: ${composed.promptModifier}.`);
  parts.push('Smooth natural motion, coherent anatomy, cinematic quality.');
  return { prompt: parts.filter(Boolean).join(' '), negativePrompt: composed.negativePrompt || undefined, plan };
}

/** Prompt for the image model that stages the opening frame (image-to-video models). */
export function keyframePrompt(ctx: Ctx, scene: SceneItem, bound: CharacterItem[], labels: Record<string, string>, settings: ProjectSettings): string {
  const composed = ctx.skills.compose(settings.skillIds);
  return [
    'Cinematic film still: the opening frame of this shot.',
    scene.promptDescription,
    scene.setting && !scene.promptDescription.includes(scene.setting) ? `Setting: ${scene.setting}.` : '',
    bound.length
      ? `Characters in frame: ${bound.map(c => `${c.name} (${labels[c.id]})`).join(', ')}. Reproduce each face, hairstyle and outfit exactly from the reference images; every listed character must be visible.`
      : '',
    `Camera shot: ${scene.cameraAngle}.`,
    composed.promptModifier ? `Visual style: ${composed.promptModifier}.` : '',
    'Natural poses mid-action, coherent anatomy, no text, no captions, no borders, no collage.'
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// 3c. Rendering
// ---------------------------------------------------------------------------------------------

export async function renderScene(
  ctx: Ctx,
  args: { scene: SceneItem; characters: CharacterItem[]; settings: ProjectSettings; signal?: AbortSignal },
  onProgress: Progress = noop
): Promise<{ video: MediaAsset; lastRender: NonNullable<SceneItem['lastRender']> }> {
  const { scene, settings, signal } = args;
  const { model, provider } = ctx.registry.resolve('video', settings.videoModel || undefined);
  const snapped = snapVideoParams(model, scene.durationSeconds, settings.resolution, settings.aspectRatio);
  const { prompt, negativePrompt, plan } = buildScenePrompt(ctx, scene, args.characters, settings, model);
  const notes = [...plan.notes];
  let refs: MediaRef[] = [];
  let keyframe: MediaAsset | undefined;

  if (plan.mode === 'keyframe') {
    const km = plan.keyframeModel!;
    const kp = ctx.registry.providers.get(km.provider)!;
    onProgress(`Cảnh ${scene.sceneNumber}: dựng khung hình đầu bằng ${km.label ?? km.id}...`);
    try {
      const layout = layoutRefs(plan.chars, km.maxReferenceImages ?? 1);
      const kfRefs = await buildRefs(ctx, layout, signal);
      const out = await kp.image!(km, {
        prompt: keyframePrompt(ctx, scene, plan.chars, layout.labels, settings),
        negativePrompt,
        aspectRatio: snapped.aspectRatio,
        referenceImages: kfRefs,
        signal
      });
      keyframe = await ctx.media.saveGenerated(out, 'image/png', `keyframe${scene.sceneNumber}`);
      refs = [toRef(ctx.media.readBuffer(keyframe), keyframe.mimeType)];
    } catch (e) {
      throwIfAborted(signal);
      notes.push(`Dựng khung hình đầu thất bại (${(e as Error).message.slice(0, 160)}) → render không có ảnh tham chiếu`);
    }
  } else if (plan.mode !== 'none') {
    refs = await buildRefs(ctx, plan, signal);
  }

  throwIfAborted(signal);
  onProgress(`Cảnh ${scene.sceneNumber}: đang render video bằng ${model.label ?? model.id}...`);
  const out = await provider.video!(model, {
    prompt,
    negativePrompt,
    ...snapped,
    referenceImages: refs,
    generateAudio: model.supportsAudio,
    label: `Cảnh ${scene.sceneNumber}: ${scene.title}`,
    signal
  });
  const video = await ctx.media.saveGenerated(out, 'video/mp4', `scene${scene.sceneNumber}`);
  return {
    video,
    lastRender: {
      model: model.id,
      durationSeconds: snapped.durationSeconds,
      resolution: snapped.resolution,
      prompt,
      references: refs.length ? (keyframe ? 'keyframe' : plan.mode) : 'none',
      keyframe,
      notes: notes.length ? notes : undefined
    }
  };
}
