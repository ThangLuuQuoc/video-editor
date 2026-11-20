import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(ffmpegPath: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd,
      windowsHide: true
    });
    let stderr = '';
    p.stderr.on('data', d => (stderr += d.toString()));
    p.on('error', err => resolve({ code: -1, stderr: String(err) }));
    p.on('close', code => resolve({ code: code ?? -1, stderr }));
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

let cached: { ok: boolean; version: string } | null = null;
export async function ffmpegStatus(ffmpegPath: string): Promise<{ ok: boolean; version: string }> {
  if (cached) return cached;
  cached = await new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-version'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.on('error', () => resolve({ ok: false, version: '' }));
    p.on('close', code => resolve({ ok: code === 0, version: out.split('\n')[0]?.trim() ?? '' }));
  });
  return cached!;
}

export function resolutionToSize(resolution: string, aspect: string): { w: number; h: number } {
  const short = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080 }[resolution] ?? 720;
  const [a, b] = aspect.split(':').map(Number);
  const even = (n: number) => Math.round(n / 2) * 2;
  if (!a || !b || a === b) return { w: short, h: short };
  return a > b ? { w: even((short * a) / b), h: short } : { w: short, h: even((short * b) / a) };
}
