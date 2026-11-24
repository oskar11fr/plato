// Markdown with LaTeX math (KaTeX) for model answers. Raw HTML in the text is
// not rendered (react-markdown's default), links open in the system browser,
// and remote images are not loaded.
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/math";
import { linkifyWikiLinks, WIKILINK_SCHEME } from "../lib/wikilinks";

const remarkPlugins = [remarkGfm, remarkMath];
// Malformed TeX renders as red source text instead of throwing.
const rehypePlugins: [typeof rehypeKatex, { throwOnError: boolean; strict: "ignore" }][] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
];

const urlTransform = (url: string) => (url.startsWith(WIKILINK_SCHEME) ? url : defaultUrlTransform(url));

function makeComponents(onWikiLink?: (target: string) => void): Components {
  return {
    a: ({ href, children }) => {
      if (href?.startsWith(WIKILINK_SCHEME)) {
        const target = decodeURIComponent(href.slice(WIKILINK_SCHEME.length));
        return (
          <a
            href="#"
            className={/#page=\d+/.test(target) ? "wikilink cite" : "wikilink"}
            title={target}
            onClick={(e) => {
              e.preventDefault();
              onWikiLink?.(target);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href && /^https?:\/\//i.test(href)) void openUrl(href);
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ""}]</span>,
  };
}

/** `onWikiLink` receives the target of a clicked [[wiki link]]. */
export const Markdown = memo(function Markdown({
  text,
  onWikiLink,
  className,
}: {
  text: string;
  onWikiLink?: (target: string) => void;
  className?: string;
}) {
  const components = useMemo(() => makeComponents(onWikiLink), [onWikiLink]);
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {linkifyWikiLinks(normalizeMathDelimiters(text))}
      </ReactMarkdown>
    </div>
  );
});
