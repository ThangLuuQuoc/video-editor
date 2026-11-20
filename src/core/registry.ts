import type { AppConfig, ModelConfig } from './config';
import type { ModelInfo, ModelKind } from './types';
import type { Provider } from './providers/base';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { FalProvider } from './providers/fal';
import { ReplicateProvider } from './providers/replicate';
import { McpProvider } from './providers/mcp';
import { MockProvider } from './providers/mock';

const CAPABILITY: Record<ModelKind, 'text' | 'image' | 'video'> = { text: 'text', image: 'image', video: 'video' };

export class ModelRegistry {
  readonly providers = new Map<string, Provider>();

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
    return { available: !reason, reason };
  }

  list(kind: ModelKind): ModelInfo[] {
    return this.config.models[kind].map(m => {
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
        supportsAudio: m.supportsAudio
      };
    });
  }

  /** Requested id → configured default → first available model of that kind. */
  resolve(kind: ModelKind, id?: string): { model: ModelConfig; provider: Provider } {
    const models = this.config.models[kind];
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

  defaultId(kind: ModelKind): string {
    try {
      return this.resolve(kind).model.id;
    } catch {
      return '';
    }
  }
}
