import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx, Progress } from './pipeline';
import type { AspectRatio, MediaAsset, SceneItem, VideoResolution } from './types';
import { ffmpegStatus, probe, resolutionToSize, runFfmpeg } from './ffmpeg';

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/**
 * Split a scene's dialogue into timed cues: one cue per spoken line, timed proportionally
 * to its length (the Flow version showed the whole dialogue for the whole clip).
 */
export function dialogueCues(dialogue: string, duration: number): { start: number; end: number; text: string }[] {
  const lines = dialogue
    .split(/\n+/)
    .map(l => l.trim().replace(/^["“”']+|["“”']+$/g, '').replace(/:\s*["“]/, ': ').replace(/["”]\s*$/, ''))
    .filter(Boolean);
  if (!lines.length || duration <= 0) return [];
  const total = lines.reduce((a, l) => a + l.length, 0);
  let t = 0;
  return lines.map(text => {
    const len = (text.length / total) * duration;
    const cue = { start: t, end: Math.min(duration, t + len), text };
    t += len;
    return cue;
  });
}

export function buildSrt(cues: { start: number; end: number; text: string }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

const SUB_STYLE =
  "force_style='FontName=Arial,FontSize=16,PrimaryColour=&H008AF0FE,OutlineColour=&H00000000,BackColour=&H99000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=18'";

/**
 * Merge completed scenes into one MP4 with ffmpeg: normalise every clip (size, fps, audio),
 * mix in the scene's TTS voice track (freezing the last frame if the speech runs longer than
 * the clip), optionally burn timed subtitles, then concat losslessly. Also writes a sidecar .vtt.
 *
 * Scenes are expected to carry `voice` only when it should be used (the Director decides).
 */
export async function mergeScenes(
  ctx: Ctx,
  args: { scenes: SceneItem[]; resolution: VideoResolution; aspectRatio: AspectRatio; burnInSubtitles: boolean; signal?: AbortSignal },
  onProgress: Progress = () => {}
): Promise<{ video: MediaAsset; subtitles?: MediaAsset; durationSeconds: number; warnings: string[] }> {
  const ff = ctx.config.ffmpegPath;
  const list = args.scenes.filter(s => s.status === 'completed' && s.video && ctx.media.exists(s.video));
  if (!list.length) throw new Error('Chưa có phân cảnh nào hoàn tất để ghép');
  const { w, h } = resolutionToSize(args.resolution, args.aspectRatio);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-merge-'));
  const fullCues: { start: number; end: number; text: string }[] = [];
  const warnings: string[] = [];
  let burn = args.burnInSubtitles;
  if (burn && !(await ffmpegStatus(ff)).subtitles) {
    burn = false;
    warnings.push('ffmpeg trên máy thiếu libass (filter "subtitles") nên KHÔNG in được phụ đề vào video — phụ đề vẫn có trong file .vtt đi kèm.');
  }
  let offset = 0;
  try {
    const parts: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const sc = list[i];
      onProgress(`Đang chuẩn hóa cảnh ${i + 1}/${list.length}: "${sc.title}"`);
      const src = ctx.media.pathOf(sc.video!.file);
      const info = await probe(ff, src);
      const clipDur = info.duration || sc.durationSeconds;
      const voice = sc.voice && ctx.media.exists(sc.voice.audio) ? sc.voice : undefined;
      // Speech longer than the clip → hold the last frame so no line is cut off.
      const dur = voice ? Math.max(clipDur, voice.durationSeconds + 0.4) : clipDur;
      const cues = voice ? voice.cues.map(c => ({ start: c.start, end: Math.min(c.end, dur), text: c.text })) : dialogueCues(sc.dialogue, clipDur);
      fullCues.push(...cues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset })));
      offset += dur;

      let vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;
      if (dur > clipDur + 0.05) vf += `,tpad=stop_mode=clone:stop_duration=${(dur - clipDur).toFixed(2)}`;
      const subFile = `sub${i}.srt`;
      if (cues.length) fs.writeFileSync(path.join(dir, subFile), buildSrt(cues));

      const out = `part${i}.mp4`;
      const mk = (withSubs: boolean) => {
        const a = ['-i', src];
        let bgIn = '0:a';
        if (!info.hasAudio) {
          a.push('-f', 'lavfi', '-t', dur.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo');
          bgIn = '1:a';
        }
        if (voice) a.push('-i', ctx.media.pathOf(voice.audio.file));
        const voiceIn = `${info.hasAudio ? 1 : 2}:a`;
        const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
        const v = `[0:v]${vf}${withSubs && cues.length ? `,subtitles=${subFile}:${SUB_STYLE}` : ''}[v]`;
        // Clip audio (ambience / music) is ducked under the voice.
        const audio = voice
          ? `[${bgIn}]${norm},volume=${info.hasAudio ? 0.3 : 1},apad[bg];[${voiceIn}]${norm},apad[vo];[bg][vo]amix=inputs=2:duration=longest:normalize=0[a]`
          : `[${bgIn}]${norm},apad[a]`;
        a.push('-filter_complex', `${v};${audio}`, '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(2));
        a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', out);
        return a;
      };
      let r = await runFfmpeg(ff, mk(burn), dir, args.signal);
      if (r.code !== 0 && burn && cues.length) {
        // Usually a font / fontconfig problem — keep going without burnt-in text, but say so.
        r = await runFfmpeg(ff, mk(false), dir, args.signal);
        if (r.code === 0) warnings.push(`Không in được phụ đề vào cảnh ${sc.sceneNumber} (lỗi filter subtitles) — xem file .vtt.`);
      }
      if (r.code !== 0) throw new Error(`ffmpeg lỗi ở cảnh ${sc.sceneNumber}: ${r.stderr.slice(0, 400)}`);
      parts.push(out);
    }

    onProgress('Đang nối các cảnh thành video hoàn chỉnh...');
    fs.writeFileSync(path.join(dir, 'list.txt'), parts.map(p => `file '${p}'`).join('\n'));
    const r = await runFfmpeg(ff, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'final.mp4'], dir, args.signal);
    if (r.code !== 0) throw new Error(`ffmpeg concat lỗi: ${r.stderr.slice(0, 400)}`);

    const video = ctx.media.save(fs.readFileSync(path.join(dir, 'final.mp4')), 'video/mp4', 'movie');
    video.durationSeconds = Math.round(offset * 10) / 10;
    const subtitles = fullCues.length
      ? ctx.media.save(Buffer.from('WEBVTT\n\n' + buildSrt(fullCues).replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2')), 'text/vtt', 'movie')
      : undefined;
    return { video, subtitles, durationSeconds: video.durationSeconds, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
