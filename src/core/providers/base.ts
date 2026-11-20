import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import type { AspectRatio, VideoResolution, VoiceInfo } from '../types';

export interface TextRequest {
  prompt: string;
  system?: string;
  temperature?: number;
}

export interface MediaRef {
  dataUrl: string;
  mimeType: string;
  buffer: Buffer;
  /** Public URL after uploading to the provider's storage (fal CDN, Replicate files…). */
  url?: string;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  /** Acting directions (models that support them, e.g. gpt-4o-mini-tts). */
  instructions?: string;
  /** 1 = normal. */
  speed?: number;
  signal?: AbortSignal;
}

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  referenceImages?: MediaRef[];
  signal?: AbortSignal;
}

export interface VideoRequest {
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  resolution: VideoResolution;
  aspectRatio: AspectRatio;
  referenceImages?: MediaRef[];
  generateAudio?: boolean;
  /** Free text used by the mock provider to label the clip. */
  label?: string;
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  /** Returns a reason string when the provider cannot be used (e.g. missing key). */
  unavailableReason(): string | undefined;
  text?(model: ModelConfig, req: TextRequest): Promise<string>;
  image?(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia>;
  video?(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia>;
  speech?(model: ModelConfig, req: SpeechRequest): Promise<GeneratedMedia>;
  /** Voices discovered at runtime (e.g. OS voices). Models may also list voices in config. */
  listVoices?(model: ModelConfig): Promise<VoiceInfo[]>;
}

export class CanceledError extends Error {
  constructor() {
    super('Đã hủy');
    this.name = 'CanceledError';
  }
}

export function isCanceled(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err as Error)?.name === 'CanceledError' || (err as Error)?.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CanceledError();
}

export function keyReason(cfg: ProviderConfig, envHint: string): string | undefined {
  if (cfg.noKey) return undefined;
  return cfg.apiKey ? undefined : `Thiếu API key (${envHint})`;
}

export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const { timeoutMs = 120_000, ...rest } = init;
  const user = rest.signal ?? undefined;
  const signal = user ? AbortSignal.any([user, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal });
  } catch (e) {
    if (user?.aborted) throw new CanceledError();
    throw e;
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.detail || body?.message || body?.error || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CanceledError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new CanceledError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Variables available to request templates. */
export function templateVars(req: VideoRequest | ImageRequest, extra: Record<string, unknown> = {}) {
  const refs = req.referenceImages ?? [];
  const v = req as VideoRequest;
  return {
    prompt: req.prompt,
    negative_prompt: req.negativePrompt || undefined,
    aspect_ratio: req.aspectRatio,
    duration: v.durationSeconds,
    resolution: v.resolution,
    generate_audio: v.generateAudio,
    image: refs[0] ? refs[0].url ?? refs[0].dataUrl : undefined,
    images: refs.length ? refs.map(r => r.url ?? r.dataUrl) : undefined,
    ...extra
  };
}

export function pickEndpoint(model: ModelConfig, req: { referenceImages?: MediaRef[] }) {
  const hasRefs = (req.referenceImages?.length ?? 0) > 0;
  if (hasRefs && model.referenceModel) {
    return { endpoint: model.referenceModel, input: model.referenceInput ?? model.input };
  }
  return { endpoint: model.model ?? model.id, input: model.input };
}
