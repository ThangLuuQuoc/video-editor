import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { extractUrl } from '../json';
import { renderTemplate } from '../template';
import { httpJson, keyReason, pickEndpoint, sleep, templateVars, type ImageRequest, type Provider, type VideoRequest } from './base';

/**
 * fal.ai queue API — one adapter for hundreds of hosted models (Kling, Veo, Hailuo, Seedance,
 * Wan, LTX, Flux, Nano Banana…). Request body comes from the model's `input` template.
 */
export class FalProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    return keyReason(this.config, 'FAL_KEY');
  }

  private async run(endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const headers = { Authorization: `Key ${this.config.apiKey}`, 'Content-Type': 'application/json' };
    const base = (this.config.baseUrl || 'https://queue.fal.run').replace(/\/$/, '');
    const sub = await httpJson(`${base}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const statusUrl: string = sub.status_url ?? `${base}/${endpoint}/requests/${sub.request_id}/status`;
    const responseUrl: string = sub.response_url ?? `${base}/${endpoint}/requests/${sub.request_id}`;
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('fal.ai quá thời gian chờ');
      const st = await httpJson(statusUrl, { headers });
      if (st.status === 'COMPLETED') break;
      if (st.status === 'FAILED' || st.error) throw new Error(`fal.ai: ${st.error ?? 'thất bại'}`);
      await sleep(4000, signal);
    }
    return httpJson(responseUrl, { headers });
  }

  async image(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const body = renderTemplate(input ?? { prompt: '{{prompt}}' }, templateVars(req));
    const res = await this.run(endpoint, body);
    const url = extractUrl(res, model.output ?? 'images[0].url');
    if (!url) throw new Error(`Không thấy URL ảnh tại "${model.output ?? 'images[0].url'}"`);
    return { url };
  }

  async video(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const body = renderTemplate(input ?? { prompt: '{{prompt}}', duration: '{{duration|str}}' }, templateVars(req));
    const res = await this.run(endpoint, body, req.signal);
    const url = extractUrl(res, model.output ?? 'video.url');
    if (!url) throw new Error(`Không thấy URL video tại "${model.output ?? 'video.url'}"`);
    return { url, mimeType: 'video/mp4' };
  }
}
