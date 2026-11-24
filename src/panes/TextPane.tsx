import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { readTextFileOpt } from "../lib/backend";
import { filesChanged } from "../lib/bus";
import { parseFrontMatter } from "../lib/frontmatter";
import { splitTitle } from "../lib/summary";
import { openWikiLink, type FileParams } from "./open";

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

// Read-only for now. Markdown is rendered (with math and working [[links]]);
// "Source" shows the file as it is.
export function TextPane({ params, containerApi }: IDockviewPanelProps<FileParams>) {
  const [text, setText] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);

  const load = useCallback(() => {
    setError(null);
    readTextFileOpt(params.path).then(
      (t) => {
        setMissing(t === null);
        setText(t ?? "");
      },
      (e) => setError(String(e)),
    );
  }, [params.path]);

  useEffect(() => {
    setText(null);
    load();
  }, [load]);

  // Reload when another pane rewrites this file (e.g. a saved summary).
  useEffect(() => filesChanged.subscribe((paths) => paths.includes(params.path) && load()), [params.path, load]);

  const onWikiLink = useCallback((target: string) => openWikiLink(containerApi, target), [containerApi]);

  if (error) return <div className="pane pane-message error">{error}</div>;
  if (text === null) return <div className="pane pane-message">Loading…</div>;
  if (missing) {
    return (
      <div className="pane pane-message muted">
        {params.path.startsWith("wiki/") ? "This wiki page hasn't been written yet." : `${params.path} doesn't exist.`}
      </div>
    );
  }
  if (!isMarkdown(params.path)) {
    return (
      <div className="pane">
        <pre className="text-view">{text}</pre>
      </div>
    );
  }
  const { front, body, hasFront } = parseFrontMatter(text);
  const { title, rest } = splitTitle(body);
  return (
    <div className="pane text-pane">
      <div className="text-toolbar">
        <span className="spacer" />
        <button onClick={() => setSource((s) => !s)} aria-pressed={source}>
          {source ? "Rendered" : "Source"}
        </button>
      </div>
      {source ? (
        <pre className="text-view">{text}</pre>
      ) : (
        <div className="text-rendered">
          <article className="reading">
            {title && <h1 className="reading-title">{title}</h1>}
            {hasFront && <Properties front={front} onWikiLink={onWikiLink} />}
            <Markdown text={title ? rest : body} onWikiLink={onWikiLink} />
          </article>
        </div>
      )}
    </div>
  );
}

/** Front matter as a small table, as Obsidian shows "properties". */
function Properties({ front, onWikiLink }: { front: Record<string, unknown>; onWikiLink: (t: string) => void }) {
  const rows = Object.entries(front).filter(([k, v]) => k !== "type" && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
  if (rows.length === 0) return null;
  return (
    <details className="properties">
      <summary>Properties</summary>
      <dl>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {typeof v === "string" && /^\[\[.*\]\]$/.test(v) ? (
              <Markdown text={v} onWikiLink={onWikiLink} className="inline" />
            ) : Array.isArray(v) ? (
              v.join(", ")
            ) : (
              String(v)
            )}
          </dd>
        </div>
      ))}
      </dl>
    </details>
  );
}
