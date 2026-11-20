import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { runFfmpeg, resolutionToSize } from '../ffmpeg';
import type { ImageRequest, Provider, TextRequest, VideoRequest } from './base';

export const MOCK_TEXT_ERROR = 'MOCK_TEXT_PROVIDER';

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf'
];

function hashHue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * Offline provider so the whole pipeline runs with zero API keys:
 *  - text  → throws MOCK_TEXT so the pipeline uses the rule-based script parser
 *  - image → SVG avatar
 *  - video → ffmpeg-generated clip (animated test pattern + caption + tone)
 */
export class MockProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig & { ffmpegPath?: string }) {}

  unavailableReason() {
    return undefined;
  }

  async text(_m: ModelConfig, _r: TextRequest): Promise<string> {
    throw new Error(MOCK_TEXT_ERROR);
  }

  async image(_m: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    const name = (req.prompt.match(/^([^,.(]{1,40})/)?.[1] ?? 'AI').trim();
    const initials = name
      .split(/\s+/)
      .map(w => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    const hue = hashHue(req.prompt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,25%)"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/>
<circle cx="256" cy="200" r="96" fill="rgba(255,255,255,0.18)"/>
<rect x="136" y="310" width="240" height="160" rx="120" fill="rgba(255,255,255,0.18)"/>
<text x="256" y="230" font-family="Arial, sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="#fff">${escapeXml(initials)}</text>
<text x="256" y="490" font-family="Arial, sans-serif" font-size="28" text-anchor="middle" fill="#fff" opacity="0.85">${escapeXml(name)}</text>
</svg>`;
    return { data: Buffer.from(svg), mimeType: 'image/svg+xml' };
  }

  async video(_m: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    const ffmpeg = this.config.ffmpegPath || 'ffmpeg';
    const { w, h } = resolutionToSize(req.resolution, req.aspectRatio);
    const d = req.durationSeconds;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-mock-'));
    try {
      fs.writeFileSync(path.join(dir, 'label.txt'), `[MOCK] ${req.label ?? ''}`.slice(0, 80));
      const font = FONT_CANDIDATES.find(f => fs.existsSync(f));
      if (font) fs.copyFileSync(font, path.join(dir, 'font.ttf'));
      const fs_ = Math.max(16, Math.round(h / 18));
      const text = `drawtext=textfile=label.txt${font ? ':fontfile=font.ttf' : ''}:fontcolor=white:fontsize=${fs_}:x=(w-tw)/2:y=h*0.12:box=1:boxcolor=black@0.55:boxborderw=12`;
      const hue = hashHue(req.prompt);
      const sources = [`gradients=s=${w}x${h}:d=${d}:r=24:c0=0x${hslHex(hue)}:c1=0x${hslHex(hue + 90)}:speed=0.02`, `testsrc2=s=${w}x${h}:r=24:d=${d}`];
      const attempts = sources.flatMap(src => [{ src, vf: text }, { src, vf: '' }]);
      let last = '';
      for (const a of attempts) {
        const args = ['-f', 'lavfi', '-i', a.src, '-f', 'lavfi', '-i', `sine=frequency=${220 + (hue % 220)}:duration=${d}`];
        if (a.vf) args.push('-vf', a.vf);
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'out.mp4');
        const r = await runFfmpeg(ffmpeg, args, dir);
        if (r.code === 0) return { data: fs.readFileSync(path.join(dir, 'out.mp4')), mimeType: 'video/mp4' };
        last = r.stderr;
      }
      throw new Error(`Mock video cần ffmpeg. Lỗi: ${last.slice(0, 300)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function hslHex(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = 0.6;
  const l = 0.35;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `${f(0)}${f(8)}${f(4)}`;
}
