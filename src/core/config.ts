import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AspectRatio, ModelKind, VideoResolution } from './types';
import { log } from './log';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type ProviderType = 'openai' | 'anthropic' | 'fal' | 'replicate' | 'mcp' | 'mock';

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  /** Provider works without an API key (e.g. Ollama, LM Studio, mock). */
  noKey?: boolean;
  // MCP provider (stdio)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Extra HTTP headers (OpenRouter etc.)
  headers?: Record<string, string>;
}

export interface ModelConfig {
  id: string;
  label?: string;
  provider: string;
  /** Provider-side model name / endpoint / MCP tool name. */
  model?: string;
  /** Alternative endpoint used when reference images are present (e.g. image-to-video). */
  referenceModel?: string;
  description?: string;
  badge?: string;
  cost?: string;
  /** Request body template (see template.ts). */
  input?: Record<string, unknown>;
  referenceInput?: Record<string, unknown>;
  /** Path in the response where the media URL is found, e.g. "video.url". */
  output?: string;
  // Video / image capabilities
  durations?: number[];
  minDuration?: number;
  maxDuration?: number;
  resolutions?: VideoResolution[];
  aspectRatios?: AspectRatio[];
  maxReferenceImages?: number;
  supportsAudio?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  skillDirs: string[];
  ffmpegPath: string;
  providers: Record<string, ProviderConfig>;
  models: Record<ModelKind, ModelConfig[]>;
  defaults: Record<ModelKind, string>;
}

function substituteEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_m, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

function mergeModels(base: ModelConfig[], extra: ModelConfig[] = []): ModelConfig[] {
  const map = new Map(base.map(m => [m.id, m]));
  for (const m of extra) map.set(m.id, { ...(map.get(m.id) ?? {}), ...m });
  return [...map.values()];
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Loads config/default.config.json and deep-merges an optional ai-video.config.json
 * (path from AI_VIDEO_CONFIG, else project root). `${ENV}` placeholders are expanded.
 */
export function loadConfig(): AppConfig {
  const envFile = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch (e) {
      log.warn('Không đọc được .env', e);
    }
  }

  const base = readJson(path.join(APP_ROOT, 'config', 'default.config.json'));
  const userFile = process.env.AI_VIDEO_CONFIG || path.join(APP_ROOT, 'ai-video.config.json');
  const user = fs.existsSync(userFile) ? readJson(userFile) : {};

  const merged = {
    ...base,
    ...user,
    providers: { ...base.providers, ...(user.providers ?? {}) },
    models: {
      text: mergeModels(base.models.text, user.models?.text),
      image: mergeModels(base.models.image, user.models?.image),
      video: mergeModels(base.models.video, user.models?.video)
    },
    defaults: { ...base.defaults, ...(user.defaults ?? {}) }
  };

  const cfg = substituteEnv(merged) as AppConfig;
  cfg.port = Number(process.env.AI_VIDEO_PORT || cfg.port || 8787);
  cfg.dataDir = path.resolve(APP_ROOT, cfg.dataDir || 'data');
  cfg.skillDirs = (cfg.skillDirs?.length ? cfg.skillDirs : ['skills']).map(d => path.resolve(APP_ROOT, d));
  cfg.ffmpegPath = process.env.FFMPEG_PATH || cfg.ffmpegPath || 'ffmpeg';
  return cfg;
}
