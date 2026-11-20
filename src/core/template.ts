/**
 * Tiny request-body templating so any HTTP/MCP model can be added from config without code.
 *
 *  - A string that is exactly "{{name}}" is replaced by the typed value (number, boolean, array…).
 *  - "{{name|str}}" forces a string, "{{name|int}}" forces an integer.
 *  - Other strings interpolate, e.g. "{{duration}}s" -> "8s".
 *  - Any key whose value resolves to undefined is dropped (so optional fields like an image
 *    reference simply disappear when there is none).
 */
const EXACT = /^\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}$/;
const INLINE = /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

function applyFilter(v: unknown, filter?: string): unknown {
  if (v === undefined || v === null) return undefined;
  switch (filter) {
    case 'str':
      return String(v);
    case 'int':
      return Math.round(Number(v));
    case 'num':
      return Number(v);
    default:
      return v;
  }
}

export function renderTemplate(tpl: unknown, vars: Record<string, unknown>): unknown {
  if (typeof tpl === 'string') {
    const exact = tpl.match(EXACT);
    if (exact) return applyFilter(vars[exact[1]], exact[2]);
    let missing = false;
    const out = tpl.replace(INLINE, (_m, key: string, filter?: string) => {
      const v = applyFilter(vars[key], filter);
      if (v === undefined) {
        missing = true;
        return '';
      }
      return String(v);
    });
    return missing ? undefined : out;
  }
  if (Array.isArray(tpl)) {
    return tpl.map(item => renderTemplate(item, vars)).filter(v => v !== undefined);
  }
  if (tpl && typeof tpl === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl)) {
      const r = renderTemplate(v, vars);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return tpl;
}
