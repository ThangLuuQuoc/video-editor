import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { CanceledError, httpJson, keyReason, sleep, type ImageRequest, type Provider, type SpeechRequest, type TextRequest, type VideoRequest } from './base';

/**
 * OpenAI-compatible provider. Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, DeepSeek,
 * Groq, Ollama, LM Studio, vLLM… for text; OpenAI Images; and Sora via /videos.
 */
export class OpenAIProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  private get base() {
    return (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { ...(this.config.headers ?? {}) };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  unavailableReason() {
    return keyReason(this.config, `providers.${this.name}.apiKey`);
  }

  async text(model: ModelConfig, req: TextRequest): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt }
    ];
    const body: Record<string, unknown> = { model: model.model, messages };
    if (model.maxTokens) body.max_tokens = model.maxTokens;
    const temp = req.temperature ?? model.temperature;
    if (temp !== undefined) body.temperature = temp;
    const res = await httpJson(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 300_000
    });
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c: any) => c.text ?? '').join('');
    throw new Error('Phản hồi chat/completions không có nội dung');
  }

  async image(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    const size = req.aspectRatio === '1:1' ? '1024x1024' : ['9:16', '3:4'].includes(req.aspectRatio) ? '1024x1536' : '1536x1024';
    let res: any;
    if (req.referenceImages?.length) {
      const form = new FormData();
      form.set('model', model.model ?? 'gpt-image-1');
      form.set('prompt', req.prompt);
      form.set('size', size);
      req.referenceImages.slice(0, model.maxReferenceImages ?? 4).forEach((r, i) => {
        form.append('image[]', new Blob([new Uint8Array(r.buffer)], { type: r.mimeType }), `ref${i}.${r.mimeType.split('/')[1]}`);
      });
      res = await httpJson(`${this.base}/images/edits`, { method: 'POST', headers: this.headers(false), body: form, timeoutMs: 300_000 });
    } else {
      res = await httpJson(`${this.base}/images/generations`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: model.model ?? 'gpt-image-1', prompt: req.prompt, size, n: 1 }),
        timeoutMs: 300_000
      });
    }
    const d = res?.data?.[0];
    if (d?.b64_json) return { data: Buffer.from(d.b64_json, 'base64'), mimeType: 'image/png' };
    if (d?.url) return { url: d.url };
    throw new Error('API ảnh không trả về dữ liệu');
  }

  /** OpenAI Sora (POST /videos → poll → GET /videos/{id}/content). */
  async video(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    const portrait = ['9:16', '3:4'].includes(req.aspectRatio);
    const size = req.resolution === '1080p' ? (portrait ? '1024x1792' : '1792x1024') : portrait ? '720x1280' : '1280x720';
    const form = new FormData();
    form.set('model', model.model ?? 'sora-2');
    form.set('prompt', req.prompt);
    form.set('seconds', String(req.durationSeconds));
    form.set('size', size);
    const ref = req.referenceImages?.[0];
    if (ref) form.set('input_reference', new Blob([new Uint8Array(ref.buffer)], { type: ref.mimeType }), `ref.${ref.mimeType.split('/')[1]}`);

    let job = await httpJson(`${this.base}/videos`, { method: 'POST', headers: this.headers(false), body: form, signal: req.signal });
    const deadline = Date.now() + 20 * 60_000;
    while (!['completed', 'failed'].includes(job.status)) {
      if (Date.now() > deadline) throw new Error('Sora quá thời gian chờ');
      await sleep(5000, req.signal);
      job = await httpJson(`${this.base}/videos/${job.id}`, { headers: this.headers(), signal: req.signal });
    }
    if (job.status === 'failed') throw new Error(job.error?.message || 'Sora render thất bại');
    const content = await fetch(`${this.base}/videos/${job.id}/content`, { headers: this.headers(false) });
    if (!content.ok) throw new Error(`Tải video Sora thất bại (${content.status})`);
    return { data: Buffer.from(await content.arrayBuffer()), mimeType: 'video/mp4' };
  }

  /** POST /audio/speech (OpenAI TTS; also LocalAI / Kokoro-FastAPI and other compatible servers). */
  async speech(model: ModelConfig, req: SpeechRequest): Promise<GeneratedMedia> {
    const name = model.model ?? 'gpt-4o-mini-tts';
    const body: Record<string, unknown> = { model: name, voice: req.voice || 'alloy', input: req.text, response_format: 'mp3' };
    const speed = req.speed ?? 1;
    if (/^gpt-/.test(name)) {
      // gpt-4o-*-tts is steered by instructions (age, emotion, pace) rather than a speed knob.
      const pace = speed < 0.95 ? ' Speak slowly and clearly, articulating every word.' : '';
      if (req.instructions || pace) body.instructions = `${req.instructions ?? ''}${pace}`.trim();
    } else if (speed !== 1) body.speed = speed;
    let res: Response;
    try {
      res = await fetch(`${this.base}/audio/speech`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      });
    } catch (e) {
      if (req.signal?.aborted) throw new CanceledError();
      throw e;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} /audio/speech: ${(await res.text()).slice(0, 300)}`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
  }
}
