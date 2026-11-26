// A wiki page being drafted by the model: its versions, hand edits and
// revisions. Used for a whole-document summary and for each chapter of a book.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ask,
  openManageUsage,
  SIGN_IN_ERRORS,
  toLlmError,
  USAGE_LIMIT,
  type AskHandle,
  type ChatMessage,
  type LlmError,
} from "../lib/llm";
import { changedBlocks, splitDraft, splitTitle, type SummaryVersion } from "../lib/summary";
import { Markdown } from "./Markdown";

/** Anything with versions: a summary draft or a book chapter. */
export interface Versioned {
  versions: SummaryVersion[];
  current: number;
  saved?: { version: number };
}

export const nowIso = () => new Date().toISOString();

export interface Writer {
  running: AskHandle | null;
  /** The text so far while the model writes; null otherwise. */
  streamed: string | null;
  error: LlmError | null;
  limitReached: boolean;
  setError: (e: LlmError | null) => void;
  /** Ask the model for a page; resolves to the new version, or null if it failed (see `error`). */
  write: (request: { model?: string; system: string; messages: ChatMessage[] }) => Promise<SummaryVersion | null>;
}

/** Streams a page from the model, one request at a time. */
export function useWriter(onSignInError: () => void): Writer {
  const [running, setRunning] = useState<AskHandle | null>(null);
  const [streamed, setStreamed] = useState<string | null>(null);
  const [error, setError] = useState<LlmError | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  useEffect(() => () => running?.cancel(), [running]);

  async function write(request: { model?: string; system: string; messages: ChatMessage[] }): Promise<SummaryVersion | null> {
    if (running) return null;
    setError(null);
    setLimitReached(false);
    let text = "";
    let answerModel: string | undefined;
    let stopReason: string | null = null;
    setStreamed("");
    const handle = ask(request, (event) => {
      if (event.type === "started") answerModel = event.model || undefined;
      else if (event.type === "textDelta") {
        text += event.text;
        setStreamed(text);
      } else if (event.type === "finished") stopReason = event.stopReason;
    });
    setRunning(handle);
    try {
      await handle.done;
      if (stopReason === "refusal") throw { kind: "refusal", message: "The model declined to write this page." };
      if (!text.trim()) throw { kind: "empty", message: "The model returned nothing. Try again." };
      return {
        text,
        by: "ai",
        at: nowIso(),
        ...(answerModel ? { model: answerModel } : {}),
        ...(stopReason === "max_tokens"
          ? { note: "Cut off at the length limit." }
          : stopReason && stopReason !== "end_turn"
            ? { note: `Incomplete (${stopReason}).` }
            : {}),
      };
    } catch (err) {
      const e = toLlmError(err);
      setError(e);
      if (e.kind === USAGE_LIMIT) setLimitReached(true);
      if (SIGN_IN_ERRORS.has(e.kind)) onSignInError();
      return null;
    } finally {
      setStreamed(null);
      setRunning(null);
    }
  }

  return { running, streamed, error, limitReached, setError, write };
}

interface DraftViewProps {
  item: Versioned;
  /** A version's page body (starting with its `# Title`), and a title to show if it has none. */
  parse: (text: string) => { title: string; body: string };
  kicker: ReactNode;
  byline: ReactNode;
  writer: Writer;
  onSelect: (index: number) => void;
  onKeepEdit: (text: string) => void;
  /** Ask for a revision; resolves to whether it worked (the request box is cleared then). */
  onRevise: (feedback: string) => Promise<boolean>;
  onWikiLink: (target: string) => void;
  /** Extra header buttons (e.g. Discard). */
  headerExtra?: ReactNode;
  /** Shown instead of the request box when the reader must sign in first. */
  signIn: ReactNode;
  /** The row with the save button. */
  actions: ReactNode;
}

/** One page's versions: browse them, edit by hand, ask for changes. */
export function DraftView(props: DraftViewProps) {
  const { item, parse, writer, onWikiLink } = props;
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const running = !!writer.running;

  const shown = item.versions[item.current];
  const page = useMemo(() => (shown ? parse(shown.text) : null), [shown, parse]);
  const body = useMemo(() => (page ? splitTitle(page.body) : null), [page]);
  const blocks = useMemo(() => {
    if (!shown || !body || shown.basedOn === undefined) return null;
    const before = item.versions[shown.basedOn];
    return before ? changedBlocks(splitTitle(parse(before.text).body).rest, body.rest) : null;
  }, [item, shown, body, parse]);

  async function revise(e: FormEvent) {
    e.preventDefault();
    if (!feedback.trim() || running) return;
    if (await props.onRevise(feedback.trim())) setFeedback("");
  }

  function keepEdit() {
    if (editing !== null && editing.trim() && editing !== shown?.text) props.onKeepEdit(editing);
    setEditing(null);
  }

  return (
    <>
      <div className="summary-header">
        <button
          className="icon-button"
          aria-label="Previous version"
          disabled={item.current === 0 || running || editing !== null}
          onClick={() => props.onSelect(item.current - 1)}
        >
          ◀
        </button>
        <span className="summary-version" title={shown ? versionLabel(shown, item) : undefined}>
          Version {item.current + 1} of {item.versions.length}
        </span>
        <button
          className="icon-button"
          aria-label="Next version"
          disabled={item.current >= item.versions.length - 1 || running || editing !== null}
          onClick={() => props.onSelect(item.current + 1)}
        >
          ▶
        </button>
        {shown && <span className="summary-origin muted">{versionLabel(shown, item)}</span>}
        <span className="spacer" />
        {blocks && writer.streamed === null && editing === null && (
          <label className="checkbox small">
            <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
            Show changes
          </label>
        )}
        <button onClick={() => setEditing(shown?.text ?? "")} disabled={running || editing !== null}>
          Edit
        </button>
        {props.headerExtra}
      </div>

      {writer.streamed !== null ? (
        <StreamingView text={writer.streamed} onStop={() => writer.running?.cancel()} onWikiLink={onWikiLink} />
      ) : editing !== null ? (
        <div className="summary-edit">
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck autoFocus />
          <div className="row">
            <button className="primary" onClick={keepEdit}>
              Keep edits
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        page &&
        body && (
          <div className="summary-body">
            <article className="reading">
              <div className="kicker">{props.kicker}</div>
              <h1 className="reading-title">{body.title ?? page.title}</h1>
              {props.byline}
              {shown?.note && <div className="chat-note">{shown.note}</div>}
              {blocks && showChanges ? (
                blocks.map((b, i) => (
                  <div key={i} className={b.changed ? "summary-block changed" : "summary-block"}>
                    <Markdown text={b.block} onWikiLink={onWikiLink} />
                  </div>
                ))
              ) : (
                <Markdown text={body.rest} onWikiLink={onWikiLink} />
              )}
            </article>
          </div>
        )
      )}

      {writer.error && <ErrorLine error={writer.error} />}
      {writer.limitReached && <UsageLimit />}

      {editing === null &&
        (props.signIn || (
          <form className="chat-input" onSubmit={revise}>
            <textarea
              value={feedback}
              rows={2}
              placeholder="Ask for changes… e.g. “shorter”, “explain equation 1 step by step”"
              disabled={running}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void revise(e);
              }}
            />
            <button type="submit" disabled={running || !feedback.trim()}>
              Revise
            </button>
          </form>
        ))}

      {editing === null && props.actions}
    </>
  );
}

function versionLabel(v: SummaryVersion, item: Versioned): string {
  const saved = item.saved && item.versions[item.saved.version] === v ? " · saved" : "";
  if (v.by === "wiki") return `From the wiki${saved}`;
  if (v.by === "edit") return `Edited by hand${saved}`;
  if (v.feedback) return `Revised: “${v.feedback.length > 60 ? `${v.feedback.slice(0, 60)}…` : v.feedback}”${saved}`;
  return `First draft${saved}`;
}

/** A hand edit of the shown version, as a new version. */
export function editVersion(item: Versioned, text: string): SummaryVersion {
  return { text, by: "edit", basedOn: item.current, at: nowIso() };
}

export function StreamingView({
  text,
  onStop,
  onWikiLink,
  waiting = "Reading the document…",
}: {
  text: string;
  onStop: () => void;
  onWikiLink: (t: string) => void;
  waiting?: string;
}) {
  const { body } = splitDraft(text);
  const { title, rest } = splitTitle(body);
  return (
    <div className="summary-body streaming">
      <article className="reading">
        <div className="kicker">
          Writing… <button className="link-button" onClick={onStop}>Stop</button>
        </div>
        {title && <h1 className="reading-title">{title}</h1>}
        {body ? <Markdown text={rest} onWikiLink={onWikiLink} /> : <p className="muted">{waiting}</p>}
      </article>
    </div>
  );
}

export function ErrorLine({ error }: { error: LlmError }) {
  if (error.kind === "cancelled") return <div className="chat-note summary-status">Stopped.</div>;
  return <div className="chat-error summary-status">{error.message}</div>;
}

export function UsageLimit() {
  return (
    <div className="usage-limit">
      <strong>Usage limit reached</strong>
      <button onClick={() => void openManageUsage()}>Manage usage</button>
    </div>
  );
}

/** "Saved to <path>" or an error, with a link to open the page. */
export function SaveStatus({ status, path, onOpen }: { status: string; path?: string; onOpen: (path: string) => void }) {
  const ok = status.startsWith("Saved");
  return (
    <span className={ok ? "ok" : "error"}>
      {status}
      {ok && path && (
        <>
          {" "}
          <button className="link-button" onClick={() => onOpen(path)}>
            Open
          </button>
        </>
      )}
    </span>
  );
}
