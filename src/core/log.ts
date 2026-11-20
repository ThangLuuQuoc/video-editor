// All logs go to stderr: stdout is reserved for the MCP / ACP JSON-RPC streams.
export const log = {
  info: (...a: unknown[]) => console.error('[ai-video]', ...a),
  warn: (...a: unknown[]) => console.error('[ai-video][warn]', ...a),
  error: (...a: unknown[]) => console.error('[ai-video][error]', ...a)
};
