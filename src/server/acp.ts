import readline from 'node:readline';
import type { AppContext } from '../core/director';
import { SCRIPT_MODES } from '../core/constants';
import { log } from '../core/log';
import type { ScriptMode } from '../core/types';

/**
 * Agent Client Protocol (ACP) agent over stdio — lets ACP editors (Zed, JetBrains, Neovim
 * plugins…) drive the video director as a chat agent. Newline-delimited JSON-RPC 2.0.
 *
 * Free text that looks like a script → full pipeline. Slash commands control each step.
 */

type Json = Record<string, any>;
interface Session {
  id: string;
  projectId: string;
  cwd?: string;
  abort?: AbortController;
}

const COMMANDS = [
  { name: 'help', description: 'Hướng dẫn sử dụng' },
  { name: 'new', description: 'Tạo dự án mới', input: { hint: 'tên dự án' } },
  { name: 'script', description: 'Đặt kịch bản (không chạy pipeline)', input: { hint: 'nội dung kịch bản' } },
  { name: 'analyze', description: 'Tách kịch bản thành các cảnh' },
  { name: 'cast', description: 'Tự động tạo nhân vật + chân dung' },
  { name: 'render', description: 'Render cảnh (để trống = tất cả cảnh chưa xong)', input: { hint: 'số cảnh' } },
  { name: 'merge', description: 'Ghép các cảnh thành 1 video' },
  { name: 'make', description: 'Chạy toàn bộ: tách cảnh → nhân vật → render → ghép' },
  { name: 'status', description: 'Trạng thái dự án hiện tại' },
  { name: 'skills', description: 'Xem / chọn skill', input: { hint: 'id1 id2 … (để trống để xem danh sách)' } },
  { name: 'models', description: 'Xem model khả dụng' },
  { name: 'model', description: 'Chọn model', input: { hint: 'text|image|video <id>' } },
  { name: 'mode', description: 'Chế độ kịch bản', input: { hint: 'strict | educational | cinematic' } },
  { name: 'set', description: 'Đặt tùy chọn', input: { hint: 'resolution 720p | aspect 9:16 | subtitles on|off | autocast on|off' } }
];

export async function runAcpStdio(ctx: AppContext) {
  const d = ctx.director;
  const sessions = new Map<string, Session>();
  const pending = new Map<number, (msg: Json) => void>();
  let nextId = 1;

  const send = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const notify = (method: string, params: Json) => send({ method, params });
  const request = (method: string, params: Json) =>
    new Promise<Json>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    });

  const update = (sessionId: string, u: Json) => notify('session/update', { sessionId, update: u });
  const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  let toolSeq = 0;
  async function step<T>(s: Session, title: string, kind: string, fn: (progress: (m: string) => void) => Promise<T>): Promise<T> {
    const toolCallId = `step-${++toolSeq}`;
    update(s.id, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress' });
    const progress = (m: string) =>
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, content: [{ type: 'content', content: { type: 'text', text: m } }] });
    try {
      const r = await fn(progress);
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
      return r;
    } catch (e) {
      update(s.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: (e as Error).message } }]
      });
      throw e;
    }
  }

  /** Ask the client before spending money on a non-mock video model. */
  async function confirmSpend(s: Session, what: string): Promise<boolean> {
    const p = d.get(s.projectId);
    const { model } = ctx.registry.resolve('video', p.settings.videoModel || undefined);
    if (ctx.config.providers[model.provider]?.type === 'mock') return true;
    try {
      const res = await request('session/request_permission', {
        sessionId: s.id,
        toolCall: { toolCallId: `perm-${++toolSeq}`, title: `${what} bằng ${model.label ?? model.id}${model.cost ? ` (${model.cost})` : ''}`, kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Cho phép', kind: 'allow_once' },
          { optionId: 'reject', name: 'Hủy', kind: 'reject_once' }
        ]
      });
      if (res.error) return true; // client does not implement permissions — the user invoked the command explicitly
      return res.result?.outcome?.outcome === 'selected' && res.result.outcome.optionId === 'allow';
    } catch {
      return true;
    }
  }

  function statusText(projectId: string): string {
    const p = d.get(projectId);
    const done = p.scenes.filter(s => s.status === 'completed').length;
    const lines = [
      `**${p.name}** (\`${p.id}\`)`,
      `Model: text=${p.settings.textModel || 'mặc định'} · image=${p.settings.imageModel || 'mặc định'} · video=${p.settings.videoModel || 'mặc định'}`,
      `Skills: ${p.settings.skillIds.join(', ') || '(không)'} · Chế độ: ${p.settings.scriptMode} · ${p.settings.resolution} ${p.settings.aspectRatio}`,
      `Nhân vật: ${p.characters.map(c => c.name).join(', ') || '(chưa có)'}`,
      `Cảnh: ${done}/${p.scenes.length} đã render`,
      ...p.scenes.map(s => `  ${s.sceneNumber}. ${s.title} (${s.durationSeconds}s) — ${s.status}${s.video ? ` → ${ctx.media.pathOf(s.video.file)}` : ''}${s.errorMessage ? ` ⚠ ${s.errorMessage}` : ''}`)
    ];
    if (p.merged) lines.push(`🎬 Video hoàn chỉnh: ${ctx.media.pathOf(p.merged.file)}`);
    lines.push(`Mở trên web: http://localhost:${ctx.config.port}/?project=${p.id}`);
    return lines.join('\n') + '\n';
  }

  async function handleCommand(s: Session, cmd: string, arg: string) {
    const p = () => d.get(s.projectId);
    switch (cmd) {
      case 'help':
        return say(
          s.id,
          [
            'Dán kịch bản (hoặc đính kèm file) để tạo video tự động. Lệnh:',
            ...COMMANDS.map(c => `- /${c.name}${c.input ? ` <${c.input.hint}>` : ''} — ${c.description}`)
          ].join('\n') + '\n'
        );
      case 'new': {
        const np = d.createProject({ name: arg || undefined });
        s.projectId = np.id;
        return say(s.id, `Đã tạo dự án mới \`${np.id}\`.\n`);
      }
      case 'script':
        d.setScript(s.projectId, arg);
        return say(s.id, `Đã lưu kịch bản (${arg.length} ký tự). Gõ /make để tạo video.\n`);
      case 'analyze': {
        const r = await step(s, 'Tách kịch bản thành cảnh', 'think', pr => d.analyze(s.projectId, pr));
        if (r.warning) say(s.id, `⚠ ${r.warning}\n`);
        return say(s.id, statusText(s.projectId));
      }
      case 'cast': {
        const r = await step(s, 'Tạo dàn nhân vật', 'execute', pr => d.cast(s.projectId, pr));
        r.warnings.forEach(w => say(s.id, `⚠ ${w}\n`));
        return say(s.id, statusText(s.projectId));
      }
      case 'render': {
        if (!(await confirmSpend(s, arg ? `Render cảnh ${arg}` : 'Render các cảnh'))) return say(s.id, 'Đã hủy render.\n');
        if (arg) {
          const n = Number(arg);
          const sc = await step(s, `Render cảnh ${n}`, 'execute', pr => d.renderScene(s.projectId, n, pr));
          return say(s.id, sc.status === 'completed' ? `✅ Cảnh ${n}: ${ctx.media.pathOf(sc.video!.file)}\n` : `❌ Cảnh ${n}: ${sc.errorMessage}\n`);
        }
        await step(s, 'Render tất cả cảnh', 'execute', pr => d.renderAll(s.projectId, { onlyMissing: true }, pr));
        return say(s.id, statusText(s.projectId));
      }
      case 'merge': {
        const r = await step(s, 'Ghép video hoàn chỉnh', 'execute', pr => d.merge(s.projectId, pr));
        return say(s.id, `🎬 ${ctx.media.pathOf(r.merged!.file)}\n`);
      }
      case 'make': {
        if (arg) d.setScript(s.projectId, arg);
        return runPipeline(s);
      }
      case 'status':
        return say(s.id, statusText(s.projectId));
      case 'models': {
        const fmt = (k: 'text' | 'image' | 'video') =>
          ctx.registry
            .list(k)
            .map(m => `  ${m.available ? '✅' : '⛔'} ${m.id} — ${m.label}${m.available ? '' : ` (${m.unavailableReason})`}`)
            .join('\n');
        return say(s.id, `**Text**\n${fmt('text')}\n**Image**\n${fmt('image')}\n**Video**\n${fmt('video')}\n`);
      }
      case 'model': {
        const [kind, id] = arg.split(/\s+/);
        if (!['text', 'image', 'video'].includes(kind) || !id) return say(s.id, 'Cú pháp: /model video kling-2.1\n');
        ctx.registry.resolve(kind as any, id); // validates
        d.updateSettings(s.projectId, { [`${kind}Model`]: id } as any);
        return say(s.id, `Đã chọn ${kind} model: ${id}\n`);
      }
      case 'skills': {
        if (!arg) {
          const list = ctx.skills
            .list()
            .map(sk => `- \`${sk.id}\` [${sk.category}] ${sk.name} — ${sk.description}`)
            .join('\n');
          return say(s.id, `Skill đang dùng: ${p().settings.skillIds.join(', ') || '(không)'}\n${list}\n`);
        }
        const ids = arg.split(/[\s,]+/).filter(Boolean);
        const unknown = ids.filter(i => !ctx.skills.get(i));
        if (unknown.length) return say(s.id, `Không có skill: ${unknown.join(', ')}\n`);
        const aspect = ctx.skills.compose(ids).aspectRatio;
        d.updateSettings(s.projectId, { skillIds: ids, ...(aspect ? { aspectRatio: aspect } : {}) });
        return say(s.id, `Đã chọn skill: ${ids.join(', ')}\n`);
      }
      case 'mode': {
        if (!SCRIPT_MODES.some(m => m.id === arg)) return say(s.id, 'Chế độ: strict | educational | cinematic\n');
        d.updateSettings(s.projectId, { scriptMode: arg as ScriptMode });
        return say(s.id, `Chế độ kịch bản: ${arg}\n`);
      }
      case 'set': {
        const [key, val] = arg.split(/\s+/);
        const on = /^(on|true|1|bật)$/i.test(val ?? '');
        const map: Record<string, () => object> = {
          resolution: () => ({ resolution: val }),
          aspect: () => ({ aspectRatio: val }),
          subtitles: () => ({ burnInSubtitles: on }),
          autocast: () => ({ autoGenerateCharacters: on })
        };
        if (!map[key]) return say(s.id, 'Cú pháp: /set resolution 720p | aspect 9:16 | subtitles on | autocast off\n');
        d.updateSettings(s.projectId, map[key]() as any);
        return say(s.id, `Đã đặt ${key} = ${val}\n`);
      }
      default:
        return say(s.id, `Không hiểu lệnh /${cmd}. Gõ /help.\n`);
    }
  }

  async function runPipeline(s: Session) {
    const p = d.get(s.projectId);
    if (!p.script.trim()) return say(s.id, 'Chưa có kịch bản. Hãy dán kịch bản vào khung chat.\n');
    const a = await step(s, 'Tách kịch bản thành cảnh', 'think', pr => d.analyze(s.projectId, pr));
    say(s.id, `Đã tách **${a.project.scenes.length} cảnh** (engine: ${a.engine}).\n`);
    if (a.warning) say(s.id, `⚠ ${a.warning}\n`);
    if (a.project.settings.autoGenerateCharacters) {
      const c = await step(s, 'Tạo dàn nhân vật', 'execute', pr => d.cast(s.projectId, pr));
      say(s.id, `Nhân vật: ${c.project.characters.map(ch => ch.name).join(', ') || '(không có)'}\n`);
    }
    if (!(await confirmSpend(s, `Render ${a.project.scenes.length} cảnh`))) {
      return say(s.id, 'Đã dừng trước bước render. Gõ /render khi sẵn sàng.\n');
    }
    for (const sc of d.get(s.projectId).scenes) {
      if (s.abort?.signal.aborted) throw new Error('cancelled');
      const r = await step(s, `Render cảnh ${sc.sceneNumber}: ${sc.title}`, 'execute', pr => d.renderScene(s.projectId, sc.sceneNumber, pr));
      if (r.status === 'error') say(s.id, `❌ Cảnh ${sc.sceneNumber}: ${r.errorMessage}\n`);
    }
    if (d.get(s.projectId).scenes.some(sc => sc.status === 'completed')) {
      await step(s, 'Ghép video hoàn chỉnh', 'execute', pr => d.merge(s.projectId, pr));
    }
    say(s.id, statusText(s.projectId));
  }

  function promptText(blocks: Json[]): string {
    return (blocks ?? [])
      .map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'resource' && b.resource?.text) return b.resource.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  async function handle(method: string, params: Json): Promise<Json> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: 'ai-video-director', title: 'AI Video Director', version: '0.1.0' }
        };
      case 'authenticate':
        return {};
      case 'session/new': {
        const project = d.createProject({ name: 'Dự án ACP' });
        const s: Session = { id: `acp-${Date.now().toString(36)}`, projectId: project.id, cwd: params.cwd };
        sessions.set(s.id, s);
        setTimeout(() => {
          update(s.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS });
        }, 0);
        return { sessionId: s.id };
      }
      case 'session/prompt': {
        const s = sessions.get(params.sessionId);
        if (!s) throw Object.assign(new Error('Session không tồn tại'), { code: -32602 });
        s.abort = new AbortController();
        const text = promptText(params.prompt);
        try {
          const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
          if (m) await handleCommand(s, m[1].toLowerCase(), m[2].trim());
          else if (text.length > 40 || /cảnh|scene|thoại|dialogue/i.test(text)) {
            d.setScript(s.projectId, text);
            await runPipeline(s);
          } else await handleCommand(s, 'help', '');
          return { stopReason: 'end_turn' };
        } catch (e) {
          if (s.abort.signal.aborted) return { stopReason: 'cancelled' };
          say(s.id, `❌ Lỗi: ${(e as Error).message}\n`);
          return { stopReason: 'end_turn' };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // Response to one of our requests (e.g. session/request_permission)
    if (msg.id !== undefined && !msg.method) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'session/cancel') {
      sessions.get(msg.params?.sessionId)?.abort?.abort();
      return;
    }
    if (msg.id === undefined) return; // other notifications
    try {
      send({ id: msg.id, result: await handle(msg.method, msg.params ?? {}) });
    } catch (e: any) {
      log.error('ACP', msg.method, e);
      send({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  });
  rl.on('close', () => process.exit(0));
}
