import { spawn } from 'node:child_process';
import { CanceledError } from './providers/base';

export interface RunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(ffmpegPath: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CanceledError());
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd,
      windowsHide: true
    });
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    p.stderr.on('data', d => (stderr += d.toString()));
    p.on('error', err => resolve({ code: -1, stderr: String(err) }));
    p.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new CanceledError());
      else resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Probe a media file using `ffmpeg -i` (no ffprobe needed). */
export function probe(ffmpegPath: string, file: string): Promise<{ duration: number; hasAudio: boolean }> {
  return new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let out = '';
    p.stderr.on('data', d => (out += d.toString()));
    p.on('error', () => resolve({ duration: 0, hasAudio: false }));
    p.on('close', () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
      resolve({ duration, hasAudio: /Stream #.*Audio:/.test(out) });
    });
  });
}

function capture(ffmpegPath: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.on('error', () => resolve({ code: -1, out: '' }));
    p.on('close', code => resolve({ code: code ?? -1, out }));
  });
}

export interface FfmpegStatus {
  ok: boolean;
  version: string;
  /** The `subtitles` filter needs ffmpeg built with libass. */
  subtitles: boolean;
}

let cached: FfmpegStatus | null = null;
export async function ffmpegStatus(ffmpegPath: string): Promise<FfmpegStatus> {
  if (cached) return cached;
  const v = await capture(ffmpegPath, ['-version']);
  const f = v.code === 0 ? await capture(ffmpegPath, ['-hide_banner', '-filters']) : { code: -1, out: '' };
  cached = { ok: v.code === 0, version: v.out.split('\n')[0]?.trim() ?? '', subtitles: /^\s*\S+\s+subtitles\s/m.test(f.out) };
  return cached;
}

export function resolutionToSize(resolution: string, aspect: string): { w: number; h: number } {
  const short = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080 }[resolution] ?? 720;
  const [a, b] = aspect.split(':').map(Number);
  const even = (n: number) => Math.round(n / 2) * 2;
  if (!a || !b || a === b) return { w: short, h: short };
  return a > b ? { w: even((short * a) / b), h: short } : { w: short, h: even((short * b) / a) };
}
