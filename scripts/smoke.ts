/**
 * Smoke test for the MCP server and the ACP agent (both over stdio), using mock models.
 *   npx tsx scripts/smoke.ts
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SAMPLE_SCRIPT } from '../src/core/constants';

const tsxCli = ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts'];

async function testMcp() {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...tsxCli, 'mcp'], stderr: 'ignore' }));
  const tools = await client.listTools();
  console.log('MCP tools:', tools.tools.map(t => t.name).join(', '));
  const res = await client.listResources();
  console.log('MCP skill resources:', res.resources.length);
  const r: any = await client.callTool(
    { name: 'make_video', arguments: { script: SAMPLE_SCRIPT, name: 'MCP smoke', textModel: 'rules', imageModel: 'mock-portrait', videoModel: 'mock-video', resolution: '360p', skillIds: ['anime', 'vertical-short'] } },
    undefined,
    { timeout: 300_000 }
  );
  const out = JSON.parse(r.content[0].text);
  console.log('MCP make_video →', out.mergedVideo, '| aspect', out.settings.aspectRatio, '| notes', out.notes);
  await client.close();
}

async function testAcp() {
  const p = spawn(process.execPath, [...tsxCli, 'acp'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: p.stdout });
  const waiters = new Map<number, (m: any) => void>();
  const updates: any[] = [];
  rl.on('line', l => {
    const m = JSON.parse(l);
    if (m.method === 'session/update') updates.push(m.params.update);
    else if (m.id !== undefined && waiters.has(m.id)) waiters.get(m.id)!(m);
  });
  let id = 0;
  const call = (method: string, params: any) =>
    new Promise<any>(res => {
      const i = ++id;
      waiters.set(i, res);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });

  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.log('ACP initialize →', init.result.agentInfo.name, 'v' + init.result.protocolVersion);
  const { result } = await call('session/new', { cwd: process.cwd(), mcpServers: [] });
  const sid = result.sessionId;
  await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/model video mock-video' }] });
  await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/model image mock-portrait' }] });
  await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/set resolution 360p' }] });
  const done = await call('session/prompt', { sessionId: sid, prompt: [{ type: 'resource', resource: { uri: 'file:///kichban.txt', text: SAMPLE_SCRIPT } }] });
  console.log('ACP stopReason →', done.result.stopReason);
  console.log('ACP commands advertised:', updates.find(u => u.sessionUpdate === 'available_commands_update')?.availableCommands.length);
  console.log('ACP tool calls:', updates.filter(u => u.sessionUpdate === 'tool_call').map(u => u.title).join(' | '));
  const text = updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('');
  console.log('ACP final message tail:\n' + text.split('\n').slice(-4).join('\n'));
  p.kill();
}

await testMcp();
await testAcp();
