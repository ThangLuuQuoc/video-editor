import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from './types';
import { newId } from './constants';

const EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'text/vtt': 'vtt',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/aiff': 'aiff'
};

export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([mime, ext]) => [ext, mime])
);

export interface GeneratedMedia {
  url?: string;
  data?: Buffer;
  mimeType?: string;
}

/** Stores every generated / uploaded file on disk under <dataDir>/media. */
export class MediaStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'media');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  pathOf(file: string): string {
    const safe = path.basename(file);
    return path.join(this.dir, safe);
  }

  asset(file: string, mimeType: string): MediaAsset {
    return { id: file.replace(/\.[^.]+$/, ''), file, url: `/media/${file}`, mimeType, path: this.pathOf(file) };
  }

  newFile(mimeType: string, prefix = 'media'): string {
    return `${newId(prefix)}.${EXT[mimeType] ?? 'bin'}`;
  }

  save(data: Buffer, mimeType: string, prefix?: string): MediaAsset {
    const file = this.newFile(mimeType, prefix);
    fs.writeFileSync(this.pathOf(file), data);
    return this.asset(file, mimeType);
  }

  saveDataUrl(dataUrl: string, prefix?: string): MediaAsset {
    const m = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) throw new Error('dataUrl không hợp lệ');
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    return this.save(buf, m[1], prefix);
  }

  async saveGenerated(g: GeneratedMedia, fallbackMime: string, prefix?: string): Promise<MediaAsset> {
    if (g.data) return this.save(g.data, g.mimeType || fallbackMime, prefix);
    if (!g.url) throw new Error('Nhà cung cấp không trả về dữ liệu media');
    if (g.url.startsWith('data:')) return this.saveDataUrl(g.url, prefix);
    const res = await fetch(g.url);
    if (!res.ok) throw new Error(`Tải media thất bại (${res.status}) từ ${g.url}`);
    const mime = (res.headers.get('content-type') || g.mimeType || fallbackMime).split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    return this.save(buf, mime.startsWith('application/') ? fallbackMime : mime, prefix);
  }

  /** Copy a local file (e.g. picked by an MCP client) into the store. */
  importFile(src: string, prefix?: string): MediaAsset {
    const ext = path.extname(src).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext === 'jpeg' ? 'jpg' : ext];
    if (!mime) throw new Error(`Định dạng không hỗ trợ: ${ext}`);
    return this.save(fs.readFileSync(src), mime, prefix);
  }

  readBuffer(asset: MediaAsset): Buffer {
    return fs.readFileSync(this.pathOf(asset.file));
  }

  toDataUrl(asset: MediaAsset): string {
    return `data:${asset.mimeType};base64,${this.readBuffer(asset).toString('base64')}`;
  }

  exists(asset?: MediaAsset): boolean {
    return !!asset && fs.existsSync(this.pathOf(asset.file));
  }

  /**
   * Delete media files no project references any more. Files younger than `minAgeMs` are kept
   * (they may belong to a render that is still running and not saved yet).
   */
  gc(referenced: Set<string>, opts: { dryRun?: boolean; minAgeMs?: number } = {}): { files: string[]; bytes: number } {
    const minAge = opts.minAgeMs ?? 60 * 60_000;
    const files: string[] = [];
    let bytes = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (referenced.has(f)) continue;
      const full = path.join(this.dir, f);
      const st = fs.statSync(full);
      if (!st.isFile() || Date.now() - st.mtimeMs < minAge) continue;
      files.push(f);
      bytes += st.size;
      if (!opts.dryRun) fs.rmSync(full, { force: true });
    }
    return { files, bytes };
  }
}
