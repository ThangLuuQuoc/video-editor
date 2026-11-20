import type { ModelConfig, ProviderConfig } from '../config';
import { httpJson, keyReason, type Provider, type TextRequest } from './base';

/** Claude via the Anthropic Messages API (text only — used for script analysis & casting). */
export class AnthropicProvider implements Provider {
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    return keyReason(this.config, 'ANTHROPIC_API_KEY');
  }

  async text(model: ModelConfig, req: TextRequest): Promise<string> {
    const base = (this.config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await httpJson(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(this.config.headers ?? {})
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: model.maxTokens ?? 8000,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }]
      }),
      timeoutMs: 300_000
    });
    const text = (res.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    if (!text) throw new Error('Claude không trả về nội dung văn bản');
    return text;
  }
}
