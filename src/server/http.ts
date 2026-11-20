import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/director';
import { APP_ROOT } from '../core/config';
import { MIME_BY_EXT } from '../core/media';
import { analyzeScript, autoCast, extractCharacterSpecs, generatePortrait, buildScenePrompt } from '../core/pipeline';
import { previewVoice } from '../core/voice';
import { DEFAULT_SETTINGS, newId } from '../core/constants';
import { log } from '../core/log';
import type { CharacterItem, Project, ProjectSettings, SceneItem } from '../core/types';

type Handler = (req: { body: any; params: Record<string, string>; query: URLSearchParams }) => Promise<unknown> | unknown;

class HttpError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

export function createHttpServer(ctx: AppContext) {
  const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  const on = (method: string, pattern: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, h });
  };

  // --- meta ------------------------------------------------------------------------------
  on('GET', '/api/health', () => ctx.director.health());
  on('GET', '/api/models', async () => {
    await ctx.registry.ready();
    return {
      text: ctx.registry.list('text'),
      image: ctx.registry.list('image'),
      video: ctx.registry.list('video'),
      tts: ctx.registry.list('tts'),
      defaults: ctx.director.defaults()
    };
  });

  // --- skills ----------------------------------------------------------------------------
  on('GET', '/api/skills', () => ctx.skills.list());
  on('GET', '/api/skills/:id', ({ params }) => ctx.skills.get(params.id) ?? Promise.reject(new HttpError(404, 'Không tìm thấy skill')));
  on('POST', '/api/skills', ({ body }) => ctx.skills.save(body));
  on('DELETE', '/api/skills/:id', ({ params }) => (ctx.skills.delete(params.id), { ok: true }));

  // --- stateless helpers (no project state involved) ------------------------------------------
  on('POST', '/api/script/analyze', ({ body }) =>
    analyzeScript(ctx, { script: body.script, mode: body.mode, skillIds: body.skillIds ?? [], textModel: body.textModel || undefined, characters: body.characters })
  );
  on('POST', '/api/characters/extract', ({ body }) => extractCharacterSpecs(ctx, { script: body.script, textModel: body.textModel || undefined }));
  on('POST', '/api/characters/portrait', ({ body }) =>
    ctx.jobs.start('portrait', () => generatePortrait(ctx, { spec: body.spec, skillIds: body.skillIds ?? [], imageModel: body.imageModel || undefined }))
  );
  on('POST', '/api/characters/upload', ({ body }): CharacterItem => {
    if (!body.dataUrl) throw new HttpError(400, 'Thiếu dataUrl');
    const image = ctx.media.saveDataUrl(body.dataUrl, 'char');
    return { id: newId('char'), name: body.name || 'Nhân vật', description: body.description, image };
  });
  on('POST', '/api/characters/auto', ({ body }) =>
    ctx.jobs.start('cast', p =>
      autoCast(
        ctx,
        {
          script: body.script,
          scenes: body.scenes ?? [],
          characters: body.characters ?? [],
          skillIds: body.skillIds ?? [],
          textModel: body.textModel || undefined,
          imageModel: body.imageModel || undefined
        },
        p
      )
    )
  );
  on('POST', '/api/scenes/prompt', ({ body }) => {
    const settings = { ...DEFAULT_SETTINGS, ...(body.settings ?? {}) } as ProjectSettings;
    const { model } = ctx.registry.resolve('video', settings.videoModel || undefined);
    const r = buildScenePrompt(ctx, body.scene as SceneItem, body.characters ?? [], settings, model);
    return { prompt: r.prompt, negativePrompt: r.negativePrompt, references: r.plan.mode, notes: r.plan.notes };
  });
  on('POST', '/api/tts/preview', ({ body }) => previewVoice(ctx, { model: body.model, voice: body.voice, text: body.text, instructions: body.instructions }));
  on('POST', '/api/media/gc', ({ body }) => ctx.director.cleanupMedia(!!body?.dryRun));

  // --- jobs ------------------------------------------------------------------------------
  on('GET', '/api/jobs', ({ query }) => ctx.jobs.list({ projectId: query.get('projectId') ?? undefined, running: query.get('running') === '1' }));
  on('GET', '/api/jobs/:id', ({ params }) => ctx.jobs.get(params.id) ?? Promise.reject(new HttpError(404, 'Không tìm thấy job')));
  on('POST', '/api/jobs/:id/cancel', ({ params }) => ctx.jobs.cancel(params.id) ?? Promise.reject(new HttpError(404, 'Không tìm thấy job')));

  // --- projects (shared with MCP / ACP) -----------------------------------------------------
  on('GET', '/api/projects', () => ctx.projects.list());
  on('POST', '/api/projects', ({ body }) => ctx.director.createProject(body ?? {}));
  on('GET', '/api/projects/:id', ({ params }) => ctx.projects.get(params.id));
  on('PUT', '/api/projects/:id', ({ params, body }) => {
    const p = body as Project;
    if (p.id !== params.id) throw new HttpError(400, 'id không khớp');
    return ctx.projects.saveFromClient(p);
  });
  on('DELETE', '/api/projects/:id', ({ params }) => (ctx.projects.delete(params.id), { ok: true }));

  // Long steps run as server jobs on the saved project — closing the tab does not stop them.
  const projectJob = (kind: string, id: string, fn: (progress: (m: string) => void, signal: AbortSignal) => Promise<unknown>, sceneId?: string) => {
    ctx.projects.get(id); // 404 early
    const busy = ctx.jobs.busy(id, sceneId);
    if (busy && (busy.kind !== 'render' || !sceneId)) throw new HttpError(409, `Dự án đang chạy "${busy.kind}" — hãy chờ hoặc hủy trước`);
    return ctx.jobs.start(kind, fn, { projectId: id, sceneId });
  };
  on('POST', '/api/projects/:id/render', ({ params, body }) =>
    projectJob('render', params.id, (p, signal) => ctx.director.renderScene(params.id, String(body.sceneId), p, signal), String(body.sceneId))
  );
  on('POST', '/api/projects/:id/voice', ({ params, body }) =>
    projectJob('voice', params.id, (p, signal) => ctx.director.voiceScene(params.id, String(body.sceneId), p, signal), String(body.sceneId))
  );
  on('POST', '/api/projects/:id/render-all', ({ params, body }) =>
    projectJob('render-all', params.id, (p, signal) =>
      ctx.director.renderAll(params.id, { onlyMissing: !!body?.onlyMissing, thenMerge: !!body?.thenMerge }, p, signal)
    )
  );
  on('POST', '/api/projects/:id/merge', ({ params }) => projectJob('merge', params.id, (p, signal) => ctx.director.merge(params.id, p, signal)));

  const distDir = path.join(APP_ROOT, 'dist');

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/media/')) return serveFile(req, res, ctx.media.pathOf(decodeURIComponent(url.pathname.slice(7))));
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
        if (!route) throw new HttpError(404, 'Không có endpoint này');
        const m = url.pathname.match(route.re)!;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT'].includes(req.method!) ? await readBody(req) : undefined;
        const out = await route.h({ body, params, query: url.searchParams });
        return sendJson(res, 200, out ?? { ok: true });
      }
      // Static web build (production). In dev, Vite serves the UI and proxies /api.
      const file = path.join(distDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (file.startsWith(distDir) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
      if (fs.existsSync(path.join(distDir, 'index.html'))) return serveFile(req, res, path.join(distDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('AI-Video API đang chạy. Chạy "npm run build" để phục vụ giao diện web tại đây, hoặc dùng "npm run dev".');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(req.method, url.pathname, err);
      sendJson(res, status, { error: (err as Error).message });
    }
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 60 * 1024 * 1024) reject(new HttpError(413, 'Body quá lớn'));
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

/** Static file with HTTP Range support (needed for <video> seeking). */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const type =
    MIME_BY_EXT[ext] ?? ({ html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', ico: 'image/x-icon' } as Record<string, string>)[ext] ?? 'application/octet-stream';
  const size = fs.statSync(file).size;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}
