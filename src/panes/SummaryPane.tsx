import { ask as confirmDialog } from "@tauri-apps/plugin-dialog";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ModelPicker, SignInNotice, UsageFooter, useAssistant } from "../components/Assistant";
import { PlanWelcome } from "../components/ChatGptSignIn";
import { Markdown } from "../components/Markdown";
import { loadAnnotations } from "../lib/annotations";
import { readTextFileOpt } from "../lib/backend";
import { filesChanged } from "../lib/bus";
import { parseFrontMatter, str } from "../lib/frontmatter";
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
import { loadSkill } from "../lib/skills";
import {
  byline,
  changedBlocks,
  INDEX_FILE,
  MAX_SOURCE_CHARS,
  MIN_SOURCE_CHARS,
  parseDraft,
  revisionMessages,
  sourceLength,
  summaryRequestMessage,
  summarySystemPrompt,
  versionChain,
  wikiPageText,
  wikiPageToDraft,
  type SummaryDraft,
  type SummaryVersion,
} from "../lib/summary";
import { deleteDraft, digest, findSourcePage, loadDraft, newSourcePagePath, saveDraft, writeWikiPage } from "../lib/wiki";
import { documentText } from "../pdf/text";
import { openFile, openSettings, openWikiLink, type SummaryParams } from "./open";

const newDraft = (source: string): SummaryDraft => ({
  version: 1,
  source,
  focus: "",
  includeHighlights: true,
  versions: [],
  current: 0,
});

const nowIso = () => new Date().toISOString();

/** A draft for the wiki page that already summarizes the document, if any. */
async function draftFromWiki(docPath: string): Promise<SummaryDraft | null> {
  const page = await findSourcePage(docPath).catch(() => null);
  if (!page) return null;
  return {
    ...newDraft(docPath),
    versions: [{ text: wikiPageToDraft(page.text), by: "wiki", at: nowIso() }],
    saved: { path: page.path, version: 0, digest: await digest(page.text) },
  };
}

/**
 * One pane per document: the model writes a summary as a wiki page, the
 * reader asks for changes (or edits it by hand) until it's right, then saves
 * it to wiki/sources/. Drafts are kept in .reader/drafts/ until then.
 */
export function SummaryPane({ params, containerApi }: IDockviewPanelProps<SummaryParams>) {
  const docPath = params.docPath;
  const { auth, checkAuth, welcome, closeWelcome, models, model, setModel } = useAssistant();
  const [draft, setDraft] = useState<SummaryDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [highlightCount, setHighlightCount] = useState(0);

  const [running, setRunning] = useState<AskHandle | null>(null);
  const [streamed, setStreamed] = useState<string | null>(null);
  const [error, setError] = useState<LlmError | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [saving, setSaving] = useState(false);
  const pages = useRef<string[] | null>(null);

  // Load the saved draft, else start from the wiki page if there is one.
  useEffect(() => {
    let cancelled = false;
    pages.current = null;
    setLoaded(false);
    (async () => {
      const d = (await loadDraft(docPath).catch(() => null)) ?? (await draftFromWiki(docPath));
      const notes = await loadAnnotations(docPath).catch(() => null);
      if (cancelled) return;
      setDraft(d);
      setHighlightCount(notes?.highlights.filter((h) => !h.detached).length ?? 0);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [docPath]);

  useEffect(() => () => running?.cancel(), [running]);

  /** Show and store a changed draft. */
  function update(next: SummaryDraft) {
    setDraft(next);
    saveDraft(next).catch((e) => setStatus(`Draft not saved: ${String(e)}`));
  }

  async function sourcePages(): Promise<string[]> {
    pages.current ??= await documentText(docPath);
    return pages.current;
  }

  /** Write the first draft (no `feedback`) or revise the shown version. */
  async function generate(base: SummaryDraft, feedbackText?: string) {
    if (running) return;
    setError(null);
    setStatus(null);
    setLimitReached(false);

    let messages: ChatMessage[];
    let system: string;
    try {
      const text = await sourcePages();
      const length = sourceLength(text);
      if (length < MIN_SOURCE_CHARS) {
        throw new Error("This PDF has almost no text to read. It may be a scan without a text layer.");
      }
      if (length > MAX_SOURCE_CHARS) {
        throw new Error(
          `This document is too long to summarize in one go (${Math.round(length / 1000)}k characters; the limit is ${MAX_SOURCE_CHARS / 1000}k).`,
        );
      }
      const notes = base.includeHighlights ? await loadAnnotations(docPath).catch(() => null) : null;
      const highlights = notes?.highlights.filter((h) => !h.detached).map((h) => ({ page: h.page, quote: h.quote })) ?? [];
      const request = summaryRequestMessage(docPath, text, { focus: base.focus, highlights });
      const skill = await loadSkill("summarize-source");
      system = summarySystemPrompt(docPath, skill);
      messages =
        feedbackText === undefined
          ? [{ role: "user", content: request }]
          : revisionMessages(request, base.versions, base.current, feedbackText);
    } catch (e) {
      setError({ kind: "source", message: e instanceof Error ? e.message : String(e) });
      return;
    }

    let text = "";
    let answerModel: string | undefined;
    let stopReason: string | null = null;
    setStreamed("");
    const handle = ask({ model: model ?? undefined, system, messages }, (event) => {
      if (event.type === "started") answerModel = event.model || undefined;
      else if (event.type === "textDelta") {
        text += event.text;
        setStreamed(text);
      } else if (event.type === "finished") stopReason = event.stopReason;
    });
    setRunning(handle);
    try {
      await handle.done;
      if (stopReason === "refusal") throw { kind: "refusal", message: "The model declined to write this summary." };
      if (!text.trim()) throw { kind: "empty", message: "The model returned nothing. Try again." };
      const version: SummaryVersion = {
        text,
        by: "ai",
        at: nowIso(),
        ...(feedbackText === undefined ? {} : { basedOn: base.current, feedback: feedbackText }),
        ...(answerModel ? { model: answerModel } : {}),
        ...(stopReason === "max_tokens"
          ? { note: "Cut off at the length limit." }
          : stopReason && stopReason !== "end_turn"
            ? { note: `Incomplete (${stopReason}).` }
            : {}),
      };
      update({ ...base, versions: [...base.versions, version], current: base.versions.length });
      setFeedback("");
    } catch (err) {
      const e = toLlmError(err);
      setError(e);
      if (e.kind === USAGE_LIMIT) setLimitReached(true);
      if (SIGN_IN_ERRORS.has(e.kind)) checkAuth();
    } finally {
      setStreamed(null);
      setRunning(null);
    }
  }

  function revise(e: FormEvent) {
    e.preventDefault();
    if (draft && feedback.trim()) void generate(draft, feedback.trim());
  }

  function saveEdit() {
    if (!draft || editing === null) return;
    const shown = draft.versions[draft.current];
    if (editing.trim() && editing !== shown?.text) {
      const version: SummaryVersion = { text: editing, by: "edit", basedOn: draft.current, at: nowIso() };
      update({ ...draft, versions: [...draft.versions, version], current: draft.versions.length });
      setStatus(null);
    }
    setEditing(null);
  }

  async function startOver() {
    if (!draft) return;
    const ok = await confirmDialog(
      draft.saved
        ? "Discard this draft and its versions? The saved wiki page is kept."
        : "Discard this summary and its versions? It hasn't been saved to the wiki.",
      { title: "Discard draft", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" },
    ).catch(() => false);
    if (!ok) return;
    running?.cancel();
    await deleteDraft(docPath).catch(() => {});
    setDraft(await draftFromWiki(docPath));
    setError(null);
    setStatus(null);
    setEditing(null);
  }

  async function saveToWiki() {
    if (!draft) return;
    const version = draft.versions[draft.current];
    if (!version) return;
    setSaving(true);
    setStatus(null);
    try {
      const page = parseDraft(version.text);
      if (!page.body.trim()) throw new Error("This version has no text to save.");
      const title = page.meta.title || page.body.match(/^# (.+)$/m)?.[1] || docPath;
      const path = draft.saved?.path ?? (await findSourcePage(docPath))?.path ?? (await newSourcePagePath(title));
      const existing = await readTextFileOpt(path);
      if (existing !== null && (!draft.saved || draft.saved.path !== path || (await digest(existing)) !== draft.saved.digest)) {
        const ok = await confirmDialog(
          `${path} has changed since Plato last saved it (or was written elsewhere). Replace it with this version?`,
          { title: "Replace wiki page", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" },
        ).catch(() => false);
        if (!ok) return;
      }
      const now = nowIso();
      const created = existing ? str(parseFrontMatter(existing).front.created) || now : now;
      const model = [...versionChain(draft.versions, draft.current)].reverse().find((v) => v.model)?.model;
      const text = wikiPageText(page, { source: docPath, created, updated: now, model });
      await writeWikiPage(path, text);
      update({ ...draft, saved: { path, version: draft.current, digest: await digest(text) } });
      filesChanged.emit([path, INDEX_FILE]);
      setStatus(`Saved to ${path}`);
    } catch (e) {
      setStatus(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const onWikiLink = useCallback((target: string) => openWikiLink(containerApi, target), [containerApi]);

  const shown = draft?.versions[draft.current];
  const page = useMemo(() => (shown ? parseDraft(shown.text) : null), [shown]);
  const blocks = useMemo(() => {
    if (!draft || !shown || !page || shown.basedOn === undefined) return null;
    const before = draft.versions[shown.basedOn];
    return before ? changedBlocks(parseDraft(before.text).body, page.body) : null;
  }, [draft, shown, page]);

  if (!loaded || !auth) return <div className="pane pane-message muted">Loading…</div>;

  const signInNeeded = !auth.ready && (
    <SignInNotice
      status={auth}
      onSignedIn={checkAuth}
      onOpenSettings={() => openSettings(containerApi)}
      purpose="write summaries"
    />
  );
  const isSaved = !!draft?.saved && draft.saved.version === draft.current;

  // No draft yet: choose a focus and write the first one.
  if (!draft || draft.versions.length === 0) {
    const d = draft ?? newDraft(docPath);
    return (
      <div className="summary-pane">
        {welcome && <PlanWelcome onClose={closeWelcome} />}
        {streamed !== null ? (
          <StreamingView text={streamed} onStop={() => running?.cancel()} onWikiLink={onWikiLink} />
        ) : (
          <div className="summary-start">
            <h2>Summarize for the wiki</h2>
            <p className="muted">
              The AI reads <strong>{docPath}</strong> and writes a summary page. You can ask for changes before it's
              saved to <code>wiki/sources/</code>.
            </p>
            {signInNeeded || (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void generate(d);
                }}
              >
                <label>
                  Focus <span className="muted">(optional)</span>
                  <input
                    type="text"
                    value={d.focus}
                    placeholder="e.g. the training setup, or explain it for a newcomer"
                    onChange={(e) => setDraft({ ...d, focus: e.target.value })}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={d.includeHighlights}
                    disabled={highlightCount === 0}
                    onChange={(e) => setDraft({ ...d, includeHighlights: e.target.checked })}
                  />
                  Cover the passages I highlighted{highlightCount ? ` (${highlightCount})` : " (none yet)"}
                </label>
                <div className="row">
                  <button type="submit" className="primary">
                    Write summary
                  </button>
                  <button type="button" className="link-button" onClick={() => openSettings(containerApi)}>
                    Summary instructions…
                  </button>
                </div>
              </form>
            )}
            {error && <ErrorLine error={error} />}
            {limitReached && <UsageLimit />}
          </div>
        )}
        <div className="chat-footer">
          <ModelPicker models={models} model={model} onChange={setModel} />
          <UsageFooter />
        </div>
      </div>
    );
  }

  return (
    <div className="summary-pane">
      {welcome && <PlanWelcome onClose={closeWelcome} />}
      <div className="summary-header">
        <button
          className="icon-button"
          aria-label="Previous version"
          disabled={draft.current === 0 || !!running || editing !== null}
          onClick={() => setDraft({ ...draft, current: draft.current - 1 })}
        >
          ◀
        </button>
        <span className="summary-version" title={shown ? versionLabel(shown, draft) : undefined}>
          Version {draft.current + 1} of {draft.versions.length}
        </span>
        <button
          className="icon-button"
          aria-label="Next version"
          disabled={draft.current >= draft.versions.length - 1 || !!running || editing !== null}
          onClick={() => setDraft({ ...draft, current: draft.current + 1 })}
        >
          ▶
        </button>
        {shown && <span className="summary-origin muted">{versionLabel(shown, draft)}</span>}
        <span className="spacer" />
        {blocks && streamed === null && editing === null && (
          <label className="checkbox small">
            <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
            Show changes
          </label>
        )}
        <button onClick={() => setEditing(shown?.text ?? "")} disabled={!!running || editing !== null}>
          Edit
        </button>
        <button onClick={() => void startOver()} disabled={!!running}>
          Discard
        </button>
      </div>

      {streamed !== null ? (
        <StreamingView text={streamed} onStop={() => running?.cancel()} onWikiLink={onWikiLink} />
      ) : editing !== null ? (
        <div className="summary-edit">
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck autoFocus />
          <div className="row">
            <button className="primary" onClick={saveEdit}>
              Keep edits
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        page && (
          <div className="summary-body">
            <PageMetaLine meta={page.meta} docPath={docPath} onOpenSource={() => openFile(containerApi, docPath)} />
            {shown?.note && <div className="chat-note">{shown.note}</div>}
            {blocks && showChanges ? (
              blocks.map((b, i) => (
                <div key={i} className={b.changed ? "summary-block changed" : "summary-block"}>
                  <Markdown text={b.block} onWikiLink={onWikiLink} />
                </div>
              ))
            ) : (
              <Markdown text={page.body} onWikiLink={onWikiLink} />
            )}
          </div>
        )
      )}

      {error && <ErrorLine error={error} />}
      {limitReached && <UsageLimit />}

      {editing === null &&
        (signInNeeded || (
          <form className="chat-input" onSubmit={revise}>
            <textarea
              value={feedback}
              rows={2}
              placeholder="Ask for changes… e.g. “shorter”, “explain equation 1 step by step”"
              disabled={!!running}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) revise(e);
              }}
            />
            <button type="submit" disabled={!!running || !feedback.trim()}>
              Revise
            </button>
          </form>
        ))}

      <div className="summary-actions">
        {status && (
          <span className={status.startsWith("Saved") ? "ok" : "error"}>
            {status}
            {status.startsWith("Saved") && draft.saved && (
              <>
                {" "}
                <button className="link-button" onClick={() => openFile(containerApi, draft.saved!.path)}>
                  Open
                </button>
              </>
            )}
          </span>
        )}
        <span className="spacer" />
        {draft.saved && !status && (
          <button className="link-button" onClick={() => openFile(containerApi, draft.saved!.path)}>
            {draft.saved.path}
          </button>
        )}
        <button className="primary" onClick={() => void saveToWiki()} disabled={saving || !!running || editing !== null || isSaved}>
          {isSaved ? "Saved to wiki" : draft.saved ? "Update wiki page" : "Save to wiki"}
        </button>
      </div>
      <div className="chat-footer">
        <ModelPicker models={models} model={model} onChange={setModel} />
        <UsageFooter />
      </div>
    </div>
  );
}

function versionLabel(v: SummaryVersion, draft: SummaryDraft): string {
  const saved = draft.saved && draft.versions[draft.saved.version] === v ? " · saved" : "";
  if (v.by === "wiki") return `From the wiki${saved}`;
  if (v.by === "edit") return `Edited by hand${saved}`;
  if (v.feedback) return `Revised: “${v.feedback.length > 60 ? `${v.feedback.slice(0, 60)}…` : v.feedback}”${saved}`;
  return `First draft${saved}`;
}

function PageMetaLine({
  meta,
  docPath,
  onOpenSource,
}: {
  meta: { authors: string[]; year: number | null };
  docPath: string;
  onOpenSource: () => void;
}) {
  const by = byline(meta);
  return (
    <div className="summary-meta muted">
      {by && <span title={meta.authors.join(", ")}>{by} · </span>}
      Summary of{" "}
      <button className="link-button" onClick={onOpenSource}>
        {docPath}
      </button>
    </div>
  );
}

function StreamingView({ text, onStop, onWikiLink }: { text: string; onStop: () => void; onWikiLink: (t: string) => void }) {
  const { body } = parseDraft(text);
  return (
    <div className="summary-body streaming">
      <div className="summary-meta muted">
        Writing… <button onClick={onStop}>Stop</button>
      </div>
      {body ? <Markdown text={body} onWikiLink={onWikiLink} /> : <p className="muted">Reading the document…</p>}
    </div>
  );
}

function ErrorLine({ error }: { error: LlmError }) {
  if (error.kind === "cancelled") return <div className="chat-note summary-status">Stopped.</div>;
  return <div className="chat-error summary-status">{error.message}</div>;
}

function UsageLimit() {
  return (
    <div className="usage-limit">
      <strong>Usage limit reached</strong>
      <button onClick={() => void openManageUsage()}>Manage usage</button>
    </div>
  );
}
