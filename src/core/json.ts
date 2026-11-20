/**
 * Robustly pull a JSON value out of an LLM reply: strips markdown fences, prose before/after,
 * and trailing commas. (The Flow version only stripped a leading ```json fence.)
 */
export function extractJson<T = unknown>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  const starts = [firstArr, firstObj].filter(i => i >= 0);
  if (starts.length === 0) throw new Error('Phản hồi AI không chứa JSON');
  const start = Math.min(...starts);
  const closer = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(closer);
  if (end <= start) throw new Error('JSON không đầy đủ trong phản hồi AI');
  const slice = text.slice(start, end + 1);

  try {
    return JSON.parse(slice) as T;
  } catch {
    const repaired = slice.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(repaired) as T;
  }
}

/** Read `a.b[0].c` style paths. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Find a media URL at `path` (string, array of strings, or {url}). */
export function extractUrl(obj: unknown, path: string): string | undefined {
  let v: any = getPath(obj, path);
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object' && typeof v.url === 'string') v = v.url;
  return typeof v === 'string' ? v : undefined;
}
