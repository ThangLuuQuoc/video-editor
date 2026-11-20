import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import { getPath, extractUrl } from '../json';
import { renderTemplate } from '../template';
import { log } from '../log';
import { pickEndpoint, templateVars, type ImageRequest, type Provider, type TextRequest, type VideoRequest } from './base';

/**
 * Uses ANY external MCP server as a generation backend: `model` is the tool name and `input`
 * the arguments template. Media is read from image/resource content blocks, a URL in the text,
 * or `output` path inside structuredContent.
 */
export class McpProvider implements Provider {
  private client?: Promise<Client>;
  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    return this.config.command ? undefined : 'Thiếu "command" cho MCP server';
  }

  private connect(): Promise<Client> {
    if (!this.client) {
      this.client = (async () => {
        const transport = new StdioClientTransport({
          command: this.config.command!,
          args: this.config.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) },
          stderr: 'inherit'
        });
        const client = new Client({ name: 'ai-video-director', version: '0.1.0' });
        await client.connect(transport);
        log.info(`MCP provider "${this.name}" đã kết nối`);
        return client;
      })().catch(err => {
        this.client = undefined;
        throw err;
      });
    }
    return this.client;
  }

  private async call(tool: string, args: unknown): Promise<any> {
    const client = await this.connect();
    const res: any = await client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, {
      timeout: 30 * 60_000,
      resetTimeoutOnProgress: true
    });
    if (res.isError) {
      const msg = (res.content ?? []).map((c: any) => c.text).filter(Boolean).join(' ');
      throw new Error(`MCP tool ${tool}: ${msg || 'lỗi'}`);
    }
    return res;
  }

  private mediaFrom(res: any, model: ModelConfig, kind: 'image' | 'video'): GeneratedMedia {
    if (model.output && res.structuredContent) {
      const url = extractUrl(res.structuredContent, model.output);
      if (url) return { url };
    }
    for (const c of res.content ?? []) {
      if ((c.type === 'image' || c.type === 'audio') && c.data) return { data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType };
      if (c.type === 'resource' && c.resource?.blob) return { data: Buffer.from(c.resource.blob, 'base64'), mimeType: c.resource.mimeType };
      if (c.type === 'resource_link' && c.uri?.startsWith('http')) return { url: c.uri };
    }
    const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    const url = text.match(/(https?:\/\/[^\s"'<>)]+)/)?.[1];
    if (url) return { url };
    const p = getPath(res.structuredContent, 'path');
    if (typeof p === 'string') return { url: p.startsWith('http') ? p : `file://${p}` };
    throw new Error(`MCP tool không trả về ${kind}`);
  }

  async text(model: ModelConfig, req: TextRequest): Promise<string> {
    const args = renderTemplate(model.input ?? { prompt: '{{prompt}}', system: '{{system}}' }, { prompt: req.prompt, system: req.system });
    const res = await this.call(model.model ?? model.id, args);
    return (res.content ?? []).map((c: any) => c.text ?? '').join('');
  }

  async image(model: ModelConfig, req: ImageRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const res = await this.call(endpoint, renderTemplate(input ?? { prompt: '{{prompt}}' }, templateVars(req)));
    return this.mediaFrom(res, model, 'image');
  }

  async video(model: ModelConfig, req: VideoRequest): Promise<GeneratedMedia> {
    const { endpoint, input } = pickEndpoint(model, req);
    const res = await this.call(endpoint, renderTemplate(input ?? { prompt: '{{prompt}}', duration: '{{duration}}' }, templateVars(req)));
    return this.mediaFrom(res, model, 'video');
  }
}
