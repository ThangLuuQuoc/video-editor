import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx, Progress } from './pipeline';
import type { AspectRatio, MediaAsset, SceneItem, VideoResolution } from './types';
import { probe, resolutionToSize, runFfmpeg } from './ffmpeg';

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

/**
 * Merge completed scenes into one MP4 with ffmpeg: normalise every clip (size, fps, audio),
 * optionally burn timed subtitles, then concat losslessly. Also writes a sidecar .srt.
 */
export async function mergeScenes(
  ctx: Ctx,
  args: { scenes: SceneItem[]; resolution: VideoResolution; aspectRatio: AspectRatio; burnInSubtitles: boolean },
  onProgress: Progress = () => {}
): Promise<{ video: MediaAsset; subtitles?: MediaAsset; durationSeconds: number }> {
  const ff = ctx.config.ffmpegPath;
  const list = args.scenes.filter(s => s.status === 'completed' && s.video && ctx.media.exists(s.video));
  if (!list.length) throw new Error('Chưa có phân cảnh nào hoàn tất để ghép');
  const { w, h } = resolutionToSize(args.resolution, args.aspectRatio);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-merge-'));
  const fullCues: { start: number; end: number; text: string }[] = [];
  let offset = 0;
  try {
    const parts: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const sc = list[i];
      onProgress(`Đang chuẩn hóa cảnh ${i + 1}/${list.length}: "${sc.title}"`);
      const src = ctx.media.pathOf(sc.video!.file);
      const info = await probe(ff, src);
      const dur = info.duration || sc.durationSeconds;
      const cues = dialogueCues(sc.dialogue, dur);
      fullCues.push(...cues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset })));
      offset += dur;

      const base = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;
      let subFilter = '';
      if (args.burnInSubtitles && cues.length) {
        fs.writeFileSync(path.join(dir, `sub${i}.srt`), buildSrt(cues));
        subFilter = `,subtitles=sub${i}.srt:force_style='FontName=Arial,FontSize=16,PrimaryColour=&H008AF0FE,OutlineColour=&H00000000,BackColour=&H99000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=18'`;
      }
      const out = `part${i}.mp4`;
      const mk = (vf: string) => {
        const a = ['-i', src];
        if (!info.hasAudio) a.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
        a.push('-vf', vf, '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0');
        a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', out);
        return a;
      };
      let r = await runFfmpeg(ff, mk(base + subFilter), dir);
      if (r.code !== 0 && subFilter) r = await runFfmpeg(ff, mk(base), dir); // ffmpeg without libass
      if (r.code !== 0) throw new Error(`ffmpeg lỗi ở cảnh ${sc.sceneNumber}: ${r.stderr.slice(0, 400)}`);
      parts.push(out);
    }

    onProgress('Đang nối các cảnh thành video hoàn chỉnh...');
    fs.writeFileSync(path.join(dir, 'list.txt'), parts.map(p => `file '${p}'`).join('\n'));
    const r = await runFfmpeg(ff, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'final.mp4'], dir);
    if (r.code !== 0) throw new Error(`ffmpeg concat lỗi: ${r.stderr.slice(0, 400)}`);

    const video = ctx.media.save(fs.readFileSync(path.join(dir, 'final.mp4')), 'video/mp4', 'movie');
    video.durationSeconds = Math.round(offset * 10) / 10;
    const subtitles = fullCues.length
      ? ctx.media.save(Buffer.from('WEBVTT\n\n' + buildSrt(fullCues).replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2')), 'text/vtt', 'movie')
      : undefined;
    return { video, subtitles, durationSeconds: video.durationSeconds };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
