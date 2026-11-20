import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { extractUrl } from '../json';
import { renderTemplate } from '../template';
import { httpJson, keyReason, pickEndpoint, sleep, templateVars, type ImageRequest, type Provider, type TextRequest, type VideoRequest } from './base';

/** Replicate predictions API. `model` is "owner/name" or "owner/name:version". */
export class ReplicateProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    return keyReason(this.config, 'REPLICATE_API_TOKEN');
  }

  private async predict(endpoint: string, input: unknown, signal?: AbortSignal): Promise<any> {
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=30'
    };
    const [ref, version] = endpoint.split(':');
    const url = version ? 'https://api.replicate.com/v1/predictions' : `https://api.replicate.com/v1/models/${ref}/predictions`;
    let pred = await httpJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(version ? { version, input } : { input }),
      signal
    });
    const deadline = Date.now() + 30 * 60_000;
    while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
      if (Date.now() > deadline) throw new Error('Replicate quá thời gian chờ');
      await sleep(4000, signal);
      pred = await httpJson(pred.urls.get, { headers: { Authorization: headers.Authorization } });
    }
    if (pred.status !== 'succeeded') throw new Error(`Replicate: ${pred.error ?? pred.status}`);
    return pred;
  }

  async text(model: ModelConfig, req: TextRequest): Promise<string> {
    const body = renderTemplate(model.input ?? { prompt: '{{prompt}}', system_prompt: '{{system}}' }, {
      prompt: req.prompt,
      system: req.system
    });
    const pred = await this.predict(model.model ?? model.id, body);
    return Array.isArray(pred.output) ? pred.output.join('') : String(pred.output ?? '');
  }

  async image(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const pred = await this.predict(endpoint, renderTemplate(input ?? { prompt: '{{prompt}}' }, templateVars(req)));
    const url = extractUrl(pred, model.output ?? 'output');
    if (!url) throw new Error('Replicate không trả về URL ảnh');
    return { url };
  }

  async video(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const pred = await this.predict(endpoint, renderTemplate(input ?? { prompt: '{{prompt}}' }, templateVars(req)), req.signal);
    const url = extractUrl(pred, model.output ?? 'output');
    if (!url) throw new Error('Replicate không trả về URL video');
    return { url, mimeType: 'video/mp4' };
  }
}
