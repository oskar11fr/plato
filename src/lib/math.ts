// Models write LaTeX with either `$…$` / `$$…$$` or `\(…\)` / `\[…\]`.
// remark-math only understands dollar delimiters, so convert the bracket
// forms, leaving code spans and fenced code blocks untouched.

/** Fenced blocks (``` or ~~~, possibly unclosed while streaming) and inline code. */
const CODE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g;

export function normalizeMathDelimiters(markdown: string): string {
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(CODE)) {
    out += convert(markdown.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return out + convert(markdown.slice(last));
}

function convert(text: string): string {
  return (
    text
      // Display math: \[ … \] → $$ on their own lines (remark-math needs that for blocks).
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      // Inline math: \( … \) → $…$
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
  );
}
