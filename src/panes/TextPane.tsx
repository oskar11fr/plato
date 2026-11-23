import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { readTextFile } from "../lib/backend";
import type { FileParams } from "./open";

// Read-only for now; CodeMirror 6 replaces this.
export function TextPane({ params }: IDockviewPanelProps<FileParams>) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    readTextFile(params.path).then(setText, (e) => setError(String(e)));
  }, [params.path]);

  if (error) return <div className="pane pane-message error">{error}</div>;
  if (text === null) return <div className="pane pane-message">Loading…</div>;
  return (
    <div className="pane">
      <pre className="text-view">{text}</pre>
    </div>
  );
}
