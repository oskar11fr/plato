// Models write LaTeX with either `$…$` / `$$…$$` or `\(…\)` / `\[…\]`.
// remark-math only understands dollar delimiters, so convert the bracket
// forms, leaving code spans and fenced code blocks untouched.

/** Fenced blocks (``` or ~~~, possibly unclosed while streaming) and inline code. */
const CODE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g;

/** Where the code (fenced blocks and inline code) is in `markdown`, as [start, end) ranges. */
export function codeRanges(markdown: string): [number, number][] {
  return [...markdown.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
}

/** Apply `fn` to the parts of `markdown` outside code. */
export function outsideCode(markdown: string, fn: (text: string) => string): string {
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(CODE)) {
    out += fn(markdown.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return out + fn(markdown.slice(last));
}

export const normalizeMathDelimiters = (markdown: string) => outsideCode(markdown, convert);

function convert(text: string): string {
  return (
    text
      // Display math: \[ … \] → $$ on their own lines (remark-math needs that for blocks).
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      // Inline math: \( … \) → $…$
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
  );
}
