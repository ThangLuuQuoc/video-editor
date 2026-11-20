import crypto from 'node:crypto';
import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { extractUrl } from '../json';
import { renderTemplate } from '../template';
import { log } from '../log';
import {
  CanceledError,
  httpJson,
  isCanceled,
  keyReason,
  pickEndpoint,
  sleep,
  templateVars,
  type ImageRequest,
  type MediaRef,
  type Provider,
  type SpeechRequest,
  type VideoRequest
} from './base';

/** Uploaded reference images, keyed by content hash — the same portrait is uploaded once per process. */
const uploaded = new Map<string, string>();

/**
 * fal.ai queue API — one adapter for hundreds of hosted models (Kling, Veo, Hailuo, Seedance,
 * Wan, LTX, Flux, Nano Banana, ElevenLabs…). Request body comes from the model's `input` template.
 */
export class FalProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    return keyReason(this.config, 'FAL_KEY');
  }

  private get auth() {
    return { Authorization: `Key ${this.config.apiKey}` };
  }

  private async run(endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const headers = { ...this.auth, 'Content-Type': 'application/json' };
    const base = (this.config.baseUrl || 'https://queue.fal.run').replace(/\/$/, '');
    const sub = await httpJson(`${base}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const statusUrl: string = sub.status_url ?? `${base}/${endpoint}/requests/${sub.request_id}/status`;
    const responseUrl: string = sub.response_url ?? `${base}/${endpoint}/requests/${sub.request_id}`;
    const cancelUrl: string = sub.cancel_url ?? `${base}/${endpoint}/requests/${sub.request_id}/cancel`;
    const deadline = Date.now() + 30 * 60_000;
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('fal.ai quá thời gian chờ');
        const st = await httpJson(statusUrl, { headers: this.auth, signal });
        if (st.status === 'COMPLETED') break;
        if (st.status === 'FAILED' || st.error) throw new Error(`fal.ai: ${st.error ?? 'thất bại'}`);
        await sleep(4000, signal);
      }
    } catch (e) {
      if (isCanceled(e, signal)) {
        // Stop the request on fal's side too, so a canceled render is not billed to completion.
        await fetch(cancelUrl, { method: 'PUT', headers: this.auth, signal: AbortSignal.timeout(15_000) }).catch(() => {});
        throw new CanceledError();
      }
      throw e;
    }
    return httpJson(responseUrl, { headers: this.auth, signal });
  }

  /**
   * Upload a buffer to fal storage (CDN) and return its public URL. Sending large base64 data URIs
   * inside the JSON body is slow and some endpoints reject it; a short https URL always works.
   */
  async upload(buffer: Buffer, mimeType: string): Promise<string> {
    const key = crypto.createHash('sha1').update(buffer).digest('hex');
    const hit = uploaded.get(key);
    if (hit) return hit;
    const ext = mimeType.split('/')[1]?.split(/[+;]/)[0] || 'bin';
    const init = await httpJson('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: mimeType, file_name: `${key.slice(0, 16)}.${ext}` }),
      timeoutMs: 30_000
    });
    if (!init?.upload_url || !init?.file_url) throw new Error('fal storage không trả về upload_url');
    const put = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(120_000)
    });
    if (!put.ok) throw new Error(`Upload lên fal storage thất bại (${put.status})`);
    uploaded.set(key, init.file_url);
    return init.file_url;
  }

  private async hostRefs<T extends { referenceImages?: MediaRef[] }>(req: T): Promise<T> {
    if (!req.referenceImages?.length) return req;
    const refs = await Promise.all(
      req.referenceImages.map(async r => {
        if (r.url) return r;
        try {
          return { ...r, url: await this.upload(r.buffer, r.mimeType) };
        } catch (e) {
          log.warn('Không upload được ảnh tham chiếu lên fal storage, gửi kèm base64:', (e as Error).message);
          return r;
        }
      })
    );
    return { ...req, referenceImages: refs };
  }

  async image(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    req = await this.hostRefs(req);
    const { endpoint, input } = pickEndpoint(model, req);
    const body = renderTemplate(input ?? { prompt: '{{prompt}}' }, templateVars(req));
    const res = await this.run(endpoint, body, req.signal);
    const url = extractUrl(res, model.output ?? 'images[0].url');
    if (!url) throw new Error(`Không thấy URL ảnh tại "${model.output ?? 'images[0].url'}"`);
    return { url };
  }

  async video(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    req = await this.hostRefs(req);
    const { endpoint, input } = pickEndpoint(model, req);
    const body = renderTemplate(input ?? { prompt: '{{prompt}}', duration: '{{duration|str}}' }, templateVars(req));
    const res = await this.run(endpoint, body, req.signal);
    const url = extractUrl(res, model.output ?? 'video.url');
    if (!url) throw new Error(`Không thấy URL video tại "${model.output ?? 'video.url'}"`);
    return { url, mimeType: 'video/mp4' };
  }

  async speech(model: ModelConfig, req: SpeechRequest): Promise<GeneratedMedia> {
    const body = renderTemplate(model.input ?? { text: '{{text}}', voice: '{{voice}}' }, {
      text: req.text,
      voice: req.voice || undefined,
      speed: req.speed && req.speed !== 1 ? req.speed : undefined,
      instructions: req.instructions
    });
    const res = await this.run(model.model ?? model.id, body, req.signal);
    const url = extractUrl(res, model.output ?? 'audio.url');
    if (!url) throw new Error(`Không thấy URL audio tại "${model.output ?? 'audio.url'}"`);
    return { url, mimeType: 'audio/mpeg' };
  }
}
