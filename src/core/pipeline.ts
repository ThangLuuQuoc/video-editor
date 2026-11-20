import type { AppConfig, ModelConfig } from './config';
import type { ModelRegistry } from './registry';
import type { SkillLibrary } from './skills';
import type { MediaStore } from './media';
import type { MediaRef } from './providers/base';
import type { AspectRatio, CharacterItem, CharacterSpec, MediaAsset, ProjectSettings, SceneItem, ScriptMode, VideoResolution } from './types';
import { CAMERA_ANGLES, newId } from './constants';
import { extractJson } from './json';
import { bindCharacters, clampDuration, extractCharactersRules, mentions, parseScriptRules } from './scriptParser';
import { MOCK_TEXT_ERROR } from './providers/mock';
import { log } from './log';

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

export function buildScenePrompt(
  ctx: Ctx,
  scene: SceneItem,
  characters: CharacterItem[],
  settings: Pick<ProjectSettings, 'skillIds' | 'scriptMode'>,
  supportsAudio = true
): { prompt: string; negativePrompt?: string } {
  const composed = ctx.skills.compose(settings.skillIds);
  const bound = characters.filter(c => scene.selectedCharacterIds.includes(c.id));
  const withImages = bound.filter(c => c.image);
  const parts: string[] = [scene.promptDescription];
  if (scene.setting && !scene.promptDescription.includes(scene.setting)) parts.push(`Setting: ${scene.setting}.`);
  if (bound.length) {
    parts.push(
      `Characters: ${bound
        .map(c => {
          const ref = withImages.indexOf(c);
          return `${c.name}${c.description ? ` (${c.description})` : ''}${ref >= 0 ? ` — matches reference image ${ref + 1}` : ''}`;
        })
        .join('; ')}. Keep faces, hairstyles and outfits identical to the references.`
    );
  }
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
  return { prompt: parts.filter(Boolean).join(' '), negativePrompt: composed.negativePrompt || undefined };
}

export function referenceRefs(ctx: Ctx, characters: CharacterItem[], scene: SceneItem, max: number): MediaRef[] {
  return characters
    .filter(c => scene.selectedCharacterIds.includes(c.id) && c.image && ctx.media.exists(c.image))
    .slice(0, max)
    .map(c => {
      const buffer = ctx.media.readBuffer(c.image!);
      return { buffer, mimeType: c.image!.mimeType, dataUrl: `data:${c.image!.mimeType};base64,${buffer.toString('base64')}` };
    })
    .filter(r => r.mimeType !== 'image/svg+xml' || max === Infinity);
}

export async function renderScene(
  ctx: Ctx,
  args: { scene: SceneItem; characters: CharacterItem[]; settings: ProjectSettings; signal?: AbortSignal }
): Promise<{ video: MediaAsset; lastRender: NonNullable<SceneItem['lastRender']> }> {
  const { scene, settings } = args;
  const { model, provider } = ctx.registry.resolve('video', settings.videoModel || undefined);
  const snapped = snapVideoParams(model, scene.durationSeconds, settings.resolution, settings.aspectRatio);
  const { prompt, negativePrompt } = buildScenePrompt(ctx, scene, args.characters, settings, model.supportsAudio !== false);
  const isMock = ctx.config.providers[model.provider]?.type === 'mock';
  const refs = referenceRefs(ctx, args.characters, scene, isMock ? Infinity : model.maxReferenceImages ?? 0);
  const out = await provider.video!(model, {
    prompt,
    negativePrompt,
    ...snapped,
    referenceImages: refs,
    generateAudio: model.supportsAudio,
    label: `Cảnh ${scene.sceneNumber}: ${scene.title}`,
    signal: args.signal
  });
  const video = await ctx.media.saveGenerated(out, 'video/mp4', `scene${scene.sceneNumber}`);
  return { video, lastRender: { model: model.id, durationSeconds: snapped.durationSeconds, resolution: snapped.resolution, prompt } };
}
