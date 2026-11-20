import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx, Progress } from './pipeline';
import type { CharacterItem, MediaAsset, ProjectSettings, SceneItem, SceneVoice, VoiceCue } from './types';
import { probe, runFfmpeg } from './ffmpeg';
import { CanceledError, throwIfAborted } from './providers/base';
import { detectLang, planSceneVoices, voiceSignature } from './voicePlan';

const LEAD = 0.3; // silence before the first line
const GAP = 0.35; // pause between lines

const AUDIO_EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aiff': 'aiff', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };

async function toBuffer(g: { data?: Buffer; url?: string }, signal?: AbortSignal): Promise<Buffer> {
  if (g.data) return g.data;
  if (!g.url) throw new Error('TTS không trả về audio');
  if (g.url.startsWith('data:')) return Buffer.from(g.url.split(',')[1] ?? '', 'base64');
  const res = await fetch(g.url, { signal }).catch(e => {
    if (signal?.aborted) throw new CanceledError();
    throw e;
  });
  if (!res.ok) throw new Error(`Tải audio TTS thất bại (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Dominant dialogue language of the project — keeps each character on one voice across scenes. */
export function projectLang(scenes: Pick<SceneItem, 'dialogue'>[]): 'vi' | 'en' {
  return detectLang(scenes.map(s => s.dialogue).join('\n'));
}

export async function voicePlanFor(
  ctx: Ctx,
  args: { scene: SceneItem; characters: CharacterItem[]; settings: ProjectSettings; lang: string }
) {
  await ctx.registry.ready();
  const { model, provider } = ctx.registry.resolve('tts', args.settings.ttsModel || undefined);
  const voices = ctx.registry.voices(model.id);
  const plan = planSceneVoices(args.scene, args.characters, args.settings, model.id, voices, args.lang);
  return { model, provider, plan, signature: voiceSignature(model.id, plan) };
}

/**
 * Multi-voice TTS for one scene: each dialogue line is spoken by its character's voice, then the
 * lines are laid out on one track (lead-in + pauses). Cue times are the real speech durations,
 * so subtitles match the voice exactly.
 */
export async function generateSceneVoice(
  ctx: Ctx,
  args: { scene: SceneItem; characters: CharacterItem[]; settings: ProjectSettings; lang: string; signal?: AbortSignal },
  onProgress: Progress = () => {}
): Promise<SceneVoice> {
  const { model, provider, plan, signature } = await voicePlanFor(ctx, args);
  if (!plan.lines.length) throw new Error('Cảnh không có lời thoại để lồng tiếng');
  const ff = ctx.config.ffmpegPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-voice-'));
  try {
    const files: string[] = [];
    const durations: number[] = [];
    for (const [i, line] of plan.lines.entries()) {
      throwIfAborted(args.signal);
      onProgress(`Lồng tiếng cảnh ${args.scene.sceneNumber}: câu ${i + 1}/${plan.lines.length}${line.speaker ? ` (${line.speaker})` : ''}`);
      const out = await provider.speech!(model, { text: line.text, voice: line.voice, instructions: line.instructions, speed: plan.speed, signal: args.signal });
      const buf = await toBuffer(out, args.signal);
      const file = `l${i}.${AUDIO_EXT[out.mimeType ?? ''] ?? 'mp3'}`;
      fs.writeFileSync(path.join(dir, file), buf);
      const info = await probe(ff, path.join(dir, file));
      if (!info.duration) throw new Error(`Audio TTS câu ${i + 1} không đọc được`);
      files.push(file);
      durations.push(info.duration);
    }

    const n = files.length;
    const chains = files.map(
      (_f, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${i < n - 1 ? `,apad=pad_dur=${GAP}` : ''}[a${i}]`
    );
    const lead = Math.round(LEAD * 1000);
    const filter = `${chains.join(';')};${files.map((_f, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1,adelay=${lead}|${lead}[out]`;
    const r = await runFfmpeg(ff, [...files.flatMap(f => ['-i', f]), '-filter_complex', filter, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', 'voice.m4a'], dir, args.signal);
    if (r.code !== 0) throw new Error(`ffmpeg ghép giọng lỗi: ${r.stderr.slice(0, 300)}`);

    const cues: VoiceCue[] = [];
    let t = LEAD;
    plan.lines.forEach((l, i) => {
      cues.push({ start: t, end: t + durations[i], text: l.speaker ? `${l.speaker}: ${l.text}` : l.text, speaker: l.speaker });
      t += durations[i] + GAP;
    });
    const total = (await probe(ff, path.join(dir, 'voice.m4a'))).duration || t - GAP;
    const audio: MediaAsset = ctx.media.save(fs.readFileSync(path.join(dir, 'voice.m4a')), 'audio/mp4', `voice${args.scene.sceneNumber}`);
    audio.durationSeconds = Math.round(total * 100) / 100;
    return { audio, cues, durationSeconds: audio.durationSeconds, model: model.id, signature };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One short sample so users can audition a voice in the UI. */
export async function previewVoice(ctx: Ctx, args: { model?: string; voice: string; text?: string; instructions?: string }): Promise<MediaAsset> {
  await ctx.registry.ready();
  const { model, provider } = ctx.registry.resolve('tts', args.model || undefined);
  const text = (args.text || 'Hello! Xin chào, đây là giọng đọc thử.').slice(0, 300);
  const out = await provider.speech!(model, { text, voice: args.voice, instructions: args.instructions });
  const buf = await toBuffer(out);
  const mime = out.mimeType && AUDIO_EXT[out.mimeType] ? out.mimeType : 'audio/mpeg';
  return ctx.media.save(buf, mime, 'preview');
}
