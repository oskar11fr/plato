import { ask as confirmDialog } from "@tauri-apps/plugin-dialog";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelPicker, SignInNotice, UsageFooter, useAssistant } from "../components/Assistant";
import { PlanWelcome } from "../components/ChatGptSignIn";
import { DraftView, editVersion, ErrorLine, nowIso, SaveStatus, StreamingView, UsageLimit, useWriter } from "../components/DraftView";
import { loadAnnotations } from "../lib/annotations";
import { readTextFileOpt } from "../lib/backend";
import {
  assignPaths,
  BOOK_SUGGEST_CHARS,
  includedSections,
  isBookOverview,
  metaFromInfo,
  nextUnwritten,
  overviewMeta,
  overviewPageToDraft,
  overviewPath,
  savedChapterDigests,
  sectionPageToDraft,
  sectionsFromOutline,
  suggestLevel,
  type BookDraft,
} from "../lib/book";
import { filesChanged } from "../lib/bus";
import { parseFrontMatter, str } from "../lib/frontmatter";
import type { ChatMessage } from "../lib/llm";
import { loadSkill } from "../lib/skills";
import {
  byline,
  INDEX_FILE,
  MAX_SOURCE_CHARS,
  MIN_SOURCE_CHARS,
  pageTitle,
  parseDraft,
  revisionMessages,
  sourceLength,
  summaryRequestMessage,
  summarySystemPrompt,
  versionChain,
  wikiPageText,
  wikiPageToDraft,
  type SummaryDraft,
} from "../lib/summary";
import {
  deleteBookDraft,
  deleteDraft,
  digest,
  findSourcePage,
  loadBookDraft,
  loadDraft,
  newSourcePagePath,
  saveBookDraft,
  saveDraft,
  sourceNames,
  writeWikiPage,
} from "../lib/wiki";
import { documentContents, type DocumentContents } from "../pdf/text";
import { BookSetup, BookView, setupProblem } from "./BookSummary";
import { openFile, openSettings, openWikiLink, type SummaryParams } from "./open";

const newDraft = (source: string): SummaryDraft => ({
  version: 1,
  source,
  focus: "",
  includeHighlights: true,
  versions: [],
  current: 0,
});

/** A draft for the wiki page that already summarizes the document in one page, if any. */
async function draftFromWiki(docPath: string): Promise<SummaryDraft | null> {
  const page = await findSourcePage(docPath).catch(() => null);
  if (!page || isBookOverview(page.text)) return null;
  return {
    ...newDraft(docPath),
    versions: [{ text: wikiPageToDraft(page.text), by: "wiki", at: nowIso() }],
    saved: { path: page.path, version: 0, digest: await digest(page.text) },
  };
}

/** A new book draft for the start screen, at the suggested bookmark level. */
function newBook(docPath: string, contents: DocumentContents, existing: { meta: BookDraft["meta"] } | null): BookDraft {
  const level = suggestLevel(contents.outline, contents.pages);
  return {
    version: 1,
    kind: "book",
    source: docPath,
    meta: existing?.meta ?? metaFromInfo(contents.info, docPath),
    focus: "",
    includeHighlights: true,
    level,
    sections: sectionsFromOutline(contents.outline, level, contents.pages),
    selected: 0,
  };
}

type Mode = "whole" | "book";

/**
 * One pane per document: the model writes a summary as a wiki page, the
 * reader asks for changes (or edits it by hand) until it's right, then saves
 * it to wiki/sources/. A long document can instead get one page per chapter,
 * written and saved one at a time. Drafts are kept in .reader/drafts/.
 */
export function SummaryPane({ params, containerApi }: IDockviewPanelProps<SummaryParams>) {
  const docPath = params.docPath;
  const { auth, checkAuth, welcome, closeWelcome, models, model, setModel } = useAssistant();
  const writer = useWriter(checkAuth);
  const [draft, setDraft] = useState<SummaryDraft | null>(null);
  const [book, setBook] = useState<BookDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [highlightCount, setHighlightCount] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [writeOnOpen, setWriteOnOpen] = useState(false);

  // The start screen: the document's text and bookmarks, and how to summarize it.
  const contents = useRef<Promise<DocumentContents> | null>(null);
  const [start, setStart] = useState<{ contents: DocumentContents; mode: Mode; book: BookDraft; existingBook: boolean } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const readContents = useCallback(() => {
    contents.current ??= documentContents(docPath);
    contents.current.catch(() => (contents.current = null));
    return contents.current;
  }, [docPath]);
  const readPages = useCallback(async () => (await readContents()).pages, [readContents]);

  // Load a saved book draft, else a summary draft, else the wiki page if there is one.
  useEffect(() => {
    let cancelled = false;
    contents.current = null;
    setLoaded(false);
    setStart(null);
    (async () => {
      const b = await loadBookDraft(docPath).catch(() => null);
      const d = b ? null : ((await loadDraft(docPath).catch(() => null)) ?? (await draftFromWiki(docPath)));
      const notes = await loadAnnotations(docPath).catch(() => null);
      if (cancelled) return;
      setBook(b);
      setDraft(d);
      setHighlightCount(notes?.highlights.filter((h) => !h.detached).length ?? 0);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [docPath]);

  const needsStart = loaded && !book && (!draft || draft.versions.length === 0);

  // On the start screen, read the document to suggest one page or one per chapter.
  useEffect(() => {
    if (!needsStart || start) return;
    let cancelled = false;
    setStartError(null);
    (async () => {
      try {
        const c = await readContents();
        const page = await findSourcePage(docPath).catch(() => null);
        const existing = page && isBookOverview(page.text) ? { meta: overviewMeta(page.text) } : null;
        const b = newBook(docPath, c, existing);
        const length = sourceLength(c.pages);
        const chapters = includedSections(b).length;
        const mode: Mode = existing || length > MAX_SOURCE_CHARS || (length > BOOK_SUGGEST_CHARS && chapters >= 2) ? "book" : "whole";
        if (!cancelled) setStart({ contents: c, mode, book: b, existingBook: !!existing });
      } catch (e) {
        if (!cancelled) setStartError(`Couldn't read the document: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsStart, start, docPath, readContents]);

  /** Show and store a changed draft. */
  function update(next: SummaryDraft) {
    setDraft(next);
    saveDraft(next).catch((e) => setStatus(`Draft not saved: ${String(e)}`));
  }

  function updateBook(next: BookDraft) {
    setBook(next);
    saveBookDraft(next).catch((e) => setStatus(`Draft not saved: ${String(e)}`));
  }

  /** Write the first draft (no `feedback`) or revise the shown version. */
  async function generate(base: SummaryDraft, feedbackText?: string): Promise<boolean> {
    if (writer.running) return false;
    setStatus(null);
    let messages: ChatMessage[];
    let system: string;
    try {
      const text = await readPages();
      const length = sourceLength(text);
      if (length < MIN_SOURCE_CHARS) {
        throw new Error("This PDF has almost no text to read. It may be a scan without a text layer.");
      }
      if (length > MAX_SOURCE_CHARS) {
        throw new Error(
          `This document is too long to summarize in one go (${Math.round(length / 1000)}k characters; the limit is ${MAX_SOURCE_CHARS / 1000}k). Summarize it chapter by chapter instead.`,
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
      writer.setError({ kind: "source", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    const version = await writer.write({ model: model ?? undefined, system, messages });
    if (!version) return false;
    const v = feedbackText === undefined ? version : { ...version, basedOn: base.current, feedback: feedbackText };
    update({ ...base, versions: [...base.versions, v], current: base.versions.length });
    return true;
  }

  /** Fix the book's chapters and wiki folder, pick up chapter pages already saved, and start writing. */
  async function startBook(setup: BookDraft) {
    setStatus(null);
    try {
      const page = await findSourcePage(docPath).catch(() => null);
      const folder = page && isBookOverview(page.text) ? page.path.slice(0, page.path.lastIndexOf("/")) : undefined;
      const d = assignPaths({ ...setup, meta: { ...setup.meta, title: setup.meta.title.trim() } }, await sourceNames(), folder);
      d.sections = await Promise.all(
        d.sections.map(async (s) => {
          const text = s.path ? await readTextFileOpt(s.path).catch(() => null) : null;
          if (!s.path || !text || str(parseFrontMatter(text).front.type) !== "source-section") return s;
          return {
            ...s,
            versions: [{ text: sectionPageToDraft(text), by: "wiki" as const, at: nowIso() }],
            current: 0,
            saved: { path: s.path, version: 0, digest: await digest(text) },
          };
        }),
      );
      const overviewFile = d.folder ? overviewPath(d.folder) : null;
      const overviewText = overviewFile ? await readTextFileOpt(overviewFile).catch(() => null) : null;
      const overview = overviewText ? overviewPageToDraft(overviewText) : null;
      if (overviewFile && overviewText && overview) {
        d.overview = {
          versions: [{ text: overview, by: "wiki", at: nowIso() }],
          current: 0,
          saved: { path: overviewFile, version: 0, digest: await digest(overviewText) },
          from: savedChapterDigests(d),
        };
      }
      d.selected = nextUnwritten(d) ?? includedSections(d)[0].index;
      await saveBookDraft(d);
      setWriteOnOpen(true);
      setBook(d);
    } catch (e) {
      setStartError(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function discard() {
    const ok = await confirmDialog(
      book
        ? "Discard the chapter drafts and their versions? Chapters saved to the wiki are kept."
        : draft?.saved
          ? "Discard this draft and its versions? The saved wiki page is kept."
          : "Discard this summary and its versions? It hasn't been saved to the wiki.",
      { title: "Discard draft", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" },
    ).catch(() => false);
    if (!ok) return;
    writer.running?.cancel();
    writer.setError(null);
    setStatus(null);
    setWriteOnOpen(false);
    setStart(null);
    if (book) {
      await deleteBookDraft(docPath).catch(() => {});
      setBook(null);
      setDraft(null);
    } else {
      await deleteDraft(docPath).catch(() => {});
      setDraft(await draftFromWiki(docPath));
    }
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
      const found = await findSourcePage(docPath);
      const path = draft.saved?.path ?? (found && !isBookOverview(found.text) ? found.path : await newSourcePagePath(title));
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
      const usedModel = [...versionChain(draft.versions, draft.current)].reverse().find((v) => v.model)?.model;
      const text = wikiPageText(page, { source: docPath, created, updated: now, model: usedModel });
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
  const onOpenFile = useCallback((path: string) => openFile(containerApi, path), [containerApi]);
  const parseWhole = useCallback(
    (text: string) => {
      const p = parseDraft(text);
      return { title: pageTitle(p.meta, p.body, docPath), body: p.body };
    },
    [docPath],
  );

  if (!loaded || !auth) return <div className="pane pane-message muted">Loading…</div>;

  const signInNeeded = !auth.ready && (
    <SignInNotice
      status={auth}
      onSignedIn={checkAuth}
      onOpenSettings={() => openSettings(containerApi)}
      purpose="write summaries"
    />
  );
  const footer = (
    <div className="chat-footer">
      <ModelPicker models={models} model={model} onChange={setModel} />
      <UsageFooter />
    </div>
  );

  if (book) {
    return (
      <div className="summary-pane">
        {welcome && <PlanWelcome onClose={closeWelcome} />}
        <BookView
          draft={book}
          update={updateBook}
          docPath={docPath}
          writer={writer}
          model={model}
          pages={readPages}
          writeOnOpen={writeOnOpen}
          signIn={signInNeeded}
          onDiscard={() => void discard()}
          onWikiLink={onWikiLink}
          onOpenFile={onOpenFile}
        />
        {status && <div className="chat-error summary-status">{status}</div>}
        {footer}
      </div>
    );
  }

  // No draft yet: choose one page or one per chapter, and write the first.
  if (!draft || draft.versions.length === 0) {
    const d = draft ?? newDraft(docPath);
    const length = start ? sourceLength(start.contents.pages) : 0;
    const tooLong = length > MAX_SOURCE_CHARS;
    const chapters = start ? includedSections(start.book).length : 0;
    const problem = start && start.mode === "book" ? setupProblem(start.book, start.contents.pages) : null;
    return (
      <div className="summary-pane">
        {welcome && <PlanWelcome onClose={closeWelcome} />}
        {writer.streamed !== null ? (
          <StreamingView text={writer.streamed} onStop={() => writer.running?.cancel()} onWikiLink={onWikiLink} />
        ) : (
          <div className="summary-start">
            <h2>Summarize for the wiki</h2>
            <p className="muted">
              The AI reads <strong>{docPath}</strong> and writes a summary. You can ask for changes before it's saved to{" "}
              <code>wiki/sources/</code>.
            </p>
            {!start ? (
              startError ? <div className="chat-error summary-status">{startError}</div> : <p className="muted">Reading the document…</p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (start.mode === "book") {
                    if (!problem) void startBook({ ...start.book, focus: d.focus, includeHighlights: d.includeHighlights });
                  } else void generate(d);
                }}
              >
                <fieldset className="summary-mode">
                  <label className="checkbox">
                    <input
                      type="radio"
                      name="mode"
                      checked={start.mode === "whole"}
                      disabled={tooLong}
                      onChange={() => setStart({ ...start, mode: "whole" })}
                    />
                    <span>
                      One page for the whole document
                      {tooLong && (
                        <span className="muted"> · too long for one request ({Math.round(length / 1000)}k characters)</span>
                      )}
                    </span>
                  </label>
                  <label className="checkbox">
                    <input type="radio" name="mode" checked={start.mode === "book"} onChange={() => setStart({ ...start, mode: "book" })} />
                    <span>
                      One page per chapter
                      <span className="muted">
                        {" "}
                        ·{" "}
                        {start.contents.outline.length
                          ? `${chapters} chapters from the PDF's bookmarks`
                          : "no bookmarks; you mark where chapters start"}
                        {length > BOOK_SUGGEST_CHARS && !tooLong ? " · suggested for a document this long" : ""}
                        {start.existingBook ? " · continues the chapters already in the wiki" : ""}
                      </span>
                    </span>
                  </label>
                </fieldset>

                {start.mode === "book" && (
                  <BookSetup
                    draft={start.book}
                    pages={start.contents.pages}
                    outline={start.contents.outline}
                    onChange={(b) => setStart({ ...start, book: b })}
                  />
                )}

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
                {signInNeeded || (
                  <div className="row">
                    <button type="submit" className="primary" disabled={!!problem}>
                      {start.mode === "book" ? "Start with the first chapter" : "Write summary"}
                    </button>
                    <button type="button" className="link-button" onClick={() => openSettings(containerApi)}>
                      Summary instructions…
                    </button>
                  </div>
                )}
                {problem && <p className="muted">{problem}</p>}
              </form>
            )}
            {writer.error && <ErrorLine error={writer.error} />}
            {writer.limitReached && <UsageLimit />}
          </div>
        )}
        {footer}
      </div>
    );
  }

  const isSaved = !!draft.saved && draft.saved.version === draft.current;
  const shownMeta = parseDraft(draft.versions[draft.current]?.text ?? "").meta;

  return (
    <div className="summary-pane">
      {welcome && <PlanWelcome onClose={closeWelcome} />}
      <DraftView
        item={draft}
        parse={parseWhole}
        kicker="Source summary"
        byline={<PageMetaLine meta={shownMeta} docPath={docPath} onOpenSource={() => onOpenFile(docPath)} />}
        writer={writer}
        onSelect={(i) => setDraft({ ...draft, current: i })}
        onKeepEdit={(text) => {
          update({ ...draft, versions: [...draft.versions, editVersion(draft, text)], current: draft.versions.length });
          setStatus(null);
        }}
        onRevise={(feedback) => generate(draft, feedback)}
        onWikiLink={onWikiLink}
        headerExtra={
          <button onClick={() => void discard()} disabled={!!writer.running}>
            Discard
          </button>
        }
        signIn={signInNeeded}
        actions={
          <div className="summary-actions">
            {status && <SaveStatus status={status} path={draft.saved?.path} onOpen={onOpenFile} />}
            <span className="spacer" />
            {draft.saved && !status && (
              <button className="link-button" onClick={() => onOpenFile(draft.saved!.path)}>
                {draft.saved.path}
              </button>
            )}
            <button className="primary" onClick={() => void saveToWiki()} disabled={saving || !!writer.running || isSaved}>
              {isSaved ? "Saved to wiki" : draft.saved ? "Update wiki page" : "Save to wiki"}
            </button>
          </div>
        }
      />
      {footer}
    </div>
  );
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
    <div className="reading-byline">
      {by && (
        <span className="byline-authors" title={meta.authors.join(", ")}>
          {by}
        </span>
      )}
      {by && " · "}
      <button className="link-button source-link" onClick={onOpenSource} title={docPath}>
        {docPath.split("/").pop()}
      </button>
    </div>
  );
}
