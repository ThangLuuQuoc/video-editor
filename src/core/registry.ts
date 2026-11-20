import type { AppConfig, ModelConfig } from './config';
import type { ModelInfo, ModelKind, VoiceInfo } from './types';
import type { Provider } from './providers/base';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { FalProvider } from './providers/fal';
import { ReplicateProvider } from './providers/replicate';
import { McpProvider } from './providers/mcp';
import { MockProvider } from './providers/mock';
import { SystemTtsProvider } from './providers/system';

const CAPABILITY: Record<ModelKind, 'text' | 'image' | 'video' | 'speech'> = { text: 'text', image: 'image', video: 'video', tts: 'speech' };

export class ModelRegistry {
  readonly providers = new Map<string, Provider>();
  private discovered = new Map<string, VoiceInfo[]>();

  constructor(readonly config: AppConfig) {
    for (const [name, pc] of Object.entries(config.providers)) {
      switch (pc.type) {
        case 'openai':
          this.providers.set(name, new OpenAIProvider(name, pc));
          break;
        case 'anthropic':
          this.providers.set(name, new AnthropicProvider(name, pc));
          break;
        case 'fal':
          this.providers.set(name, new FalProvider(name, pc));
          break;
        case 'replicate':
          this.providers.set(name, new ReplicateProvider(name, pc));
          break;
        case 'mcp':
          this.providers.set(name, new McpProvider(name, pc));
          break;
        case 'system':
          this.providers.set(name, new SystemTtsProvider(name, pc));
          break;
        case 'mock':
          this.providers.set(name, new MockProvider(name, { ...pc, ffmpegPath: config.ffmpegPath }));
          break;
        default:
          throw new Error(`Provider type không hỗ trợ: ${(pc as any).type}`);
      }
    }
  }

  private status(kind: ModelKind, m: ModelConfig): { available: boolean; reason?: string } {
    const p = this.providers.get(m.provider);
    if (!p) return { available: false, reason: `Chưa cấu hình provider "${m.provider}"` };
    if (!p[CAPABILITY[kind]]) return { available: false, reason: `Provider "${m.provider}" không hỗ trợ ${kind}` };
    const reason = p.unavailableReason();
    if (!reason && kind === 'tts' && !m.voices?.length && this.discovered.has(m.id) && !this.discovered.get(m.id)!.length)
      return { available: false, reason: 'Không tìm thấy giọng đọc nào trên máy' };
    return { available: !reason, reason };
  }

  /** Discover runtime voices (OS voices…) once; call before list('tts') / resolve('tts'). */
  async ready(): Promise<void> {
    await Promise.all(
      (this.config.models.tts ?? []).map(async m => {
        if (m.voices?.length || this.discovered.has(m.id)) return;
        const p = this.providers.get(m.provider);
        if (!p?.listVoices || p.unavailableReason()) return;
        this.discovered.set(m.id, await p.listVoices(m).catch(() => []));
      })
    );
  }

  voices(modelId: string): VoiceInfo[] {
    const m = (this.config.models.tts ?? []).find(x => x.id === modelId);
    return m?.voices ?? this.discovered.get(modelId) ?? [];
  }

  list(kind: ModelKind): ModelInfo[] {
    return (this.config.models[kind] ?? []).map(m => {
      const st = this.status(kind, m);
      const p = this.config.providers[m.provider];
      return {
        id: m.id,
        kind,
        label: m.label ?? m.id,
        provider: m.provider,
        providerType: p?.type ?? 'unknown',
        description: m.description,
        badge: m.badge,
        cost: m.cost,
        available: st.available,
        unavailableReason: st.reason,
        durations: m.durations,
        minDuration: m.minDuration,
        maxDuration: m.maxDuration,
        resolutions: m.resolutions,
        aspectRatios: m.aspectRatios,
        maxReferenceImages: m.maxReferenceImages,
        referenceMode: m.referenceMode,
        supportsAudio: m.supportsAudio,
        voices: kind === 'tts' ? this.voices(m.id) : undefined
      };
    });
  }

  /** Requested id → configured default → first available model of that kind. */
  resolve(kind: ModelKind, id?: string): { model: ModelConfig; provider: Provider } {
    const models = this.config.models[kind] ?? [];
    if (id) {
      const m = models.find(x => x.id === id);
      if (!m) throw new Error(`Không tìm thấy model ${kind} "${id}"`);
      const st = this.status(kind, m);
      if (!st.available) throw new Error(`Model "${id}" chưa sẵn sàng: ${st.reason}`);
      return { model: m, provider: this.providers.get(m.provider)! };
    }
    const def = models.find(x => x.id === this.config.defaults[kind]);
    if (def && this.status(kind, def).available) return { model: def, provider: this.providers.get(def.provider)! };
    const first = models.find(m => this.status(kind, m).available);
    if (!first) throw new Error(`Không có model ${kind} nào sẵn sàng`);
    return { model: first, provider: this.providers.get(first.provider)! };
  }

  find(kind: ModelKind, id: string | undefined): ModelConfig | undefined {
    return id ? (this.config.models[kind] ?? []).find(m => m.id === id) : undefined;
  }

  isAvailable(kind: ModelKind, id: string): boolean {
    const m = this.find(kind, id);
    return !!m && this.status(kind, m).available;
  }

  defaultId(kind: ModelKind): string {
    try {
      return this.resolve(kind).model.id;
    } catch {
      return '';
    }
  }
}
