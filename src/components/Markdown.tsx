// Markdown with LaTeX math (KaTeX) for model answers. Raw HTML in the text is
// not rendered (react-markdown's default), links open in the system browser,
// and remote images are not loaded.
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/math";

const remarkPlugins = [remarkGfm, remarkMath];
// Malformed TeX renders as red source text instead of throwing.
const rehypePlugins: [typeof rehypeKatex, { throwOnError: boolean; strict: "ignore" }][] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
];

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ""}]</span>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  );
});
