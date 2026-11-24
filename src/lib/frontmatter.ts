// YAML front matter as Plato writes it: one `key: value` per line, every
// value written as JSON (which is valid YAML). Reading is tolerant of hand
// edits and of models: plain YAML scalars and simple `- item` lists work too.

export type FrontMatter = Record<string, unknown>;

const FRONT = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/** Split a Markdown file into its front matter and body. */
export function parseFrontMatter(text: string): { front: FrontMatter; body: string; hasFront: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const m = normalized.match(FRONT);
  if (!m) return { front: {}, body: normalized, hasFront: false };
  const front: FrontMatter = {};
  let listKey: string | null = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (front[listKey] as unknown[]).push(scalar(item[1]));
      continue;
    }
    listKey = null;
    const i = line.indexOf(":");
    if (i <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (raw === "") {
      front[key] = [];
      listKey = key; // a block list may follow
    } else {
      front[key] = scalar(raw);
    }
  }
  return { front, body: normalized.slice(m[0].length), hasFront: true };
}

function scalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, ""); // a plain YAML scalar
  }
}

/** Front matter block (with the closing `---` and a newline). */
export function serializeFrontMatter(entries: [string, unknown][]): string {
  const lines = entries.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return ["---", ...lines, "---", ""].join("\n");
}

export const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "string" && v ? [v] : [];
