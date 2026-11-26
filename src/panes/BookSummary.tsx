// Summarizing a book chapter by chapter: choosing the chapters, then writing,
// reviewing and saving one chapter at a time.
import { ask as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DraftView, editVersion, ErrorLine, SaveStatus, StreamingView, UsageLimit, type Writer } from "../components/DraftView";
import { loadAnnotations } from "../lib/annotations";
import { readTextFileOpt } from "../lib/backend";
import {
  chapterNumber,
  chaptersChangedSince,
  includedSections,
  nextUnwritten,
  outlineLevels,
  OVERVIEW,
  overviewPageText,
  overviewPath,
  overviewRequestMessage,
  overviewSystemPrompt,
  pageRange,
  parseSection,
  savedChapterDigests,
  sectionChars,
  sectionPageText,
  sectionRequestMessage,
  sectionsFromOutline,
  sectionSystemPrompt,
  withEnds,
  type BookDraft,
  type BookOverview,
  type BookSection,
} from "../lib/book";
import { filesChanged } from "../lib/bus";
import { parseFrontMatter, str } from "../lib/frontmatter";
import type { ChatMessage } from "../lib/llm";
import { loadSkill } from "../lib/skills";
import { byline as bylineOf, INDEX_FILE, MAX_SOURCE_CHARS, MIN_SOURCE_CHARS, revisionMessages, versionChain } from "../lib/summary";
import { digest, writeWikiPage } from "../lib/wiki";
import type { OutlineNode } from "../pdf/text";

const kChars = (n: number) => `${Math.max(1, Math.round(n / 1000))}k characters`;

/** The chapter list and book details, checked before writing starts. */
export function BookSetup({
  draft,
  pages,
  outline,
  onChange,
}: {
  draft: BookDraft;
  pages: string[];
  outline: OutlineNode[];
  onChange: (d: BookDraft) => void;
}) {
  const levels = outlineLevels(outline);
  const numPages = pages.length;
  const setSection = (i: number, change: Partial<BookSection>) =>
    onChange({ ...draft, sections: draft.sections.map((s, j) => (j === i ? { ...s, ...change } : s)) });
  const settle = (sections: BookSection[]) => onChange({ ...draft, sections: withEnds(sections, numPages) });
  const included = includedSections(draft);

  function addSection() {
    const last = draft.sections[draft.sections.length - 1];
    const start = Math.min(numPages, last ? last.start + 1 : 1);
    settle([...draft.sections, { title: "New section", depth: 0, start, end: start, include: true, versions: [], current: 0 }]);
  }

  // Enter in these fields shouldn't submit the form (and start writing).
  const noSubmit = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
  };

  return (
    <div className="book-setup" onKeyDown={noSubmit}>
      <label>
        Book title
        <input type="text" value={draft.meta.title} onChange={(e) => onChange({ ...draft, meta: { ...draft.meta, title: e.target.value } })} />
      </label>
      <div className="book-fields">
        <label>
          Authors <span className="muted">(separated by semicolons)</span>
          <input
            type="text"
            value={draft.meta.authors.join("; ")}
            onChange={(e) =>
              onChange({ ...draft, meta: { ...draft.meta, authors: e.target.value.split(";").map((a) => a.trimStart()) } })
            }
            onBlur={() => onChange({ ...draft, meta: { ...draft.meta, authors: draft.meta.authors.map((a) => a.trim()).filter(Boolean) } })}
          />
        </label>
        <label className="book-year">
          Year
          <input
            type="text"
            inputMode="numeric"
            value={draft.meta.year ?? ""}
            onChange={(e) => {
              const year = Number.parseInt(e.target.value, 10);
              onChange({ ...draft, meta: { ...draft.meta, year: Number.isFinite(year) ? year : null } });
            }}
          />
        </label>
      </div>

      <div className="book-sections">
        <div className="book-sections-head">
          <span>
            Chapters <span className="muted">· {included.length} included, one request each</span>
          </span>
          {levels > 1 && (
            <select
              value={draft.level}
              aria-label="Bookmark level"
              onChange={(e) => {
                const level = Number(e.target.value);
                onChange({ ...draft, level, sections: sectionsFromOutline(outline, level, pages) });
              }}
            >
              {Array.from({ length: levels }, (_, level) => (
                <option key={level} value={level}>
                  Bookmark level {level + 1} ({sectionsFromOutline(outline, level, pages).filter((s) => s.include).length} chapters)
                </option>
              ))}
            </select>
          )}
        </div>
        {draft.sections.length === 0 && (
          <p className="muted">This PDF has no bookmarks. Add the chapters and the pages they start on.</p>
        )}
        <ol className="book-section-list">
          {draft.sections.map((s, i) => {
            const chars = sectionChars(pages, s);
            return (
              <li key={i} className={s.include ? "" : "excluded"} style={{ paddingLeft: s.depth * 16 }}>
                <input
                  type="checkbox"
                  checked={s.include}
                  aria-label={`Include ${s.title}`}
                  onChange={(e) => setSection(i, { include: e.target.checked })}
                />
                <input type="text" className="book-section-title" value={s.title} onChange={(e) => setSection(i, { title: e.target.value })} />
                <span className="book-section-pages muted">
                  p.
                  <input
                    type="number"
                    min={1}
                    max={numPages}
                    value={s.start}
                    aria-label={`First page of ${s.title}`}
                    onChange={(e) => setSection(i, { start: Number(e.target.value) })}
                    onBlur={() => settle(draft.sections)}
                  />
                  {s.end > s.start ? `–${s.end}` : ""}
                </span>
                <span className={`book-section-size ${s.include && chars > MAX_SOURCE_CHARS ? "error" : "muted"}`}>
                  {s.include && chars > MAX_SOURCE_CHARS ? "too long: split it" : s.include && chars < MIN_SOURCE_CHARS ? "no text" : kChars(chars)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${s.title}`}
                  title="Remove (its pages join the section before)"
                  onClick={() => settle(draft.sections.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="link-button" onClick={addSection}>
          Add a section
        </button>
      </div>
    </div>
  );
}

/** Whether writing can start, and if not, why. */
export function setupProblem(draft: BookDraft, pages: string[]): string | null {
  const included = includedSections(draft);
  if (!draft.meta.title.trim()) return "Give the book a title.";
  if (included.length === 0) return "Include at least one chapter.";
  const long = included.find((c) => sectionChars(pages, c.section) > MAX_SOURCE_CHARS);
  if (long) return `“${long.section.title}” is too long for one request. Pick a deeper bookmark level or split it.`;
  return null;
}

interface BookViewProps {
  draft: BookDraft;
  update: (d: BookDraft) => void;
  docPath: string;
  writer: Writer;
  model: string | null;
  pages: () => Promise<string[]>;
  /** Write the selected chapter right away (after "Start writing"). */
  writeOnOpen: boolean;
  signIn: ReactNode;
  onDiscard: () => void;
  onWikiLink: (target: string) => void;
  onOpenFile: (path: string) => void;
}

/** A book being summarized: one chapter shown at a time, written, reviewed and saved in order. */
export function BookView(props: BookViewProps) {
  const { draft, writer, docPath } = props;
  const latest = useRef(draft);
  latest.current = draft;
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const running = !!writer.running;

  const chapters = includedSections(draft);
  const showOverview = draft.selected === OVERVIEW;
  const index = draft.sections[draft.selected]?.include ? draft.selected : (chapters[0]?.index ?? 0);
  const section = draft.sections[index];
  const number = chapterNumber(draft, index);
  // The overview comes first, then the chapters in order.
  const nav = [OVERVIEW, ...chapters.map((c) => c.index)];
  const position = nav.indexOf(showOverview ? OVERVIEW : index);
  const savedCount = chapters.filter((c) => c.section.saved).length;
  const writtenCount = chapters.filter((c) => c.section.versions.length).length;
  const overview: BookOverview = draft.overview ?? { versions: [], current: 0 };

  function change(next: BookDraft) {
    latest.current = next;
    props.update(next);
  }

  function setSection(i: number, fn: (s: BookSection) => BookSection, base = latest.current) {
    change({ ...base, sections: base.sections.map((s, j) => (j === i ? fn(s) : s)) });
  }

  function setOverview(fn: (o: BookOverview) => BookOverview) {
    const base = latest.current;
    change({ ...base, overview: fn(base.overview ?? { versions: [], current: 0 }) });
  }

  function select(i: number) {
    setStatus(null);
    writer.setError(null);
    change({ ...latest.current, selected: i });
  }

  /** Write a chapter's first draft (no `feedback`) or revise its shown version. */
  async function write(i: number, feedback?: string): Promise<boolean> {
    if (writer.running) return false;
    setStatus(null);
    const base = latest.current;
    const s = base.sections[i];
    let system: string;
    let messages: ChatMessage[];
    try {
      const pages = await props.pages();
      const chars = sectionChars(pages, s);
      if (chars < MIN_SOURCE_CHARS) throw new Error("This chapter has almost no text to read. It may be scanned pages without a text layer.");
      if (chars > MAX_SOURCE_CHARS) throw new Error(`This chapter is too long for one request (${kChars(chars)}).`);
      const notes = base.includeHighlights ? await loadAnnotations(docPath).catch(() => null) : null;
      const highlights = notes?.highlights.filter((h) => !h.detached).map((h) => ({ page: h.page, quote: h.quote })) ?? [];
      const request = sectionRequestMessage(base, i, pages, { highlights });
      system = sectionSystemPrompt(docPath, await loadSkill("summarize-section"));
      messages =
        feedback === undefined ? [{ role: "user", content: request }] : revisionMessages(request, s.versions, s.current, feedback);
    } catch (e) {
      writer.setError({ kind: "source", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    const version = await writer.write({ model: props.model ?? undefined, system, messages });
    if (!version) return false;
    const v = feedback === undefined ? version : { ...version, basedOn: s.current, feedback };
    setSection(i, (cur) => ({ ...cur, versions: [...cur.versions, v], current: cur.versions.length }));
    return true;
  }

  /** Write the overview from the chapter pages (no `feedback`), or revise its shown version. */
  async function writeOverview(feedback?: string): Promise<boolean> {
    if (writer.running) return false;
    setStatus(null);
    const base = latest.current;
    const o = base.overview ?? { versions: [], current: 0 };
    let system: string;
    let messages: ChatMessage[];
    try {
      if (!includedSections(base).some((c) => c.section.versions.length)) throw new Error("Write some chapters first: the overview is written from their pages.");
      const request = overviewRequestMessage(base);
      system = overviewSystemPrompt(docPath, await loadSkill("summarize-book"));
      messages = feedback === undefined || o.versions.length === 0 ? [{ role: "user", content: request }] : revisionMessages(request, o.versions, o.current, feedback);
    } catch (e) {
      writer.setError({ kind: "source", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    const version = await writer.write({ model: props.model ?? undefined, system, messages });
    if (!version) return false;
    const v = feedback === undefined || o.versions.length === 0 ? version : { ...version, basedOn: o.current, feedback };
    setOverview((cur) => ({ ...cur, versions: [...cur.versions, v], current: cur.versions.length, from: savedChapterDigests(base) }));
    return true;
  }

  async function saveOverview() {
    const d = latest.current;
    const o = d.overview;
    const version = o?.versions[o.current];
    if (!o || !version || !d.folder) return;
    setSaving(true);
    setStatus(null);
    try {
      if (!parseSection(version.text).body.trim()) throw new Error("This version has no text to save.");
      const path = overviewPath(d.folder);
      const existing = await readTextFileOpt(path);
      const now = new Date().toISOString();
      const created = existing ? str(parseFrontMatter(existing).front.created) || now : now;
      const saved = { path, version: o.current, digest: "" };
      const text = overviewPageText({ ...d, overview: { ...o, saved } }, { created, updated: now });
      saved.digest = await digest(text);
      await writeWikiPage(path, text);
      setOverview((cur) => ({ ...cur, saved }));
      filesChanged.emit([path, INDEX_FILE]);
      setStatus(`Saved to ${path}`);
    } catch (e) {
      setStatus(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function openOverview(write: boolean) {
    select(OVERVIEW);
    if (write) void writeOverview();
  }

  // "Start writing" opens the book on its first chapter and writes it.
  const wroteOnOpen = useRef(false);
  useEffect(() => {
    if (props.writeOnOpen && !wroteOnOpen.current && section && section.versions.length === 0) {
      wroteOnOpen.current = true;
      void write(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(i: number) {
    const d = latest.current;
    const s = d.sections[i];
    const version = s.versions[s.current];
    if (!version || !s.path || !d.folder) return;
    setSaving(true);
    setStatus(null);
    try {
      const page = parseSection(version.text);
      if (!page.body.trim()) throw new Error("This version has no text to save.");
      const existing = await readTextFileOpt(s.path);
      if (existing !== null && (!s.saved || (await digest(existing)) !== s.saved.digest)) {
        const ok = await confirmDialog(
          `${s.path} has changed since Plato last saved it (or was written elsewhere). Replace it with this version?`,
          { title: "Replace wiki page", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" },
        ).catch(() => false);
        if (!ok) return;
      }
      const now = new Date().toISOString();
      const created = (text: string | null) => (text ? str(parseFrontMatter(text).front.created) || now : now);
      const model = [...versionChain(s.versions, s.current)].reverse().find((v) => v.model)?.model;
      const text = sectionPageText(d, i, page, { created: created(existing), updated: now, model });
      const saved = { path: s.path, version: s.current, digest: await digest(text) };
      const next = { ...d, sections: d.sections.map((x, j) => (j === i ? { ...x, saved } : x)) };
      const overview = overviewPath(d.folder);
      const overviewText = overviewPageText(next, { created: created(await readTextFileOpt(overview)), updated: now });
      await writeWikiPage(s.path, text, [overview, overviewText]);
      change({ ...latest.current, sections: latest.current.sections.map((x, j) => (j === i ? { ...x, saved } : x)) });
      filesChanged.emit([s.path, overview, INDEX_FILE]);
      setStatus(`Saved to ${s.path}`);
    } catch (e) {
      setStatus(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function writeNext(i: number) {
    select(i);
    void write(i);
  }

  const parse = useCallback(
    (text: string) => {
      const p = parseSection(text);
      return { title: p.title || section?.title || "", body: p.body };
    },
    [section?.title],
  );
  const parseOverview = useCallback(
    (text: string) => {
      const p = parseSection(text);
      return { title: p.title || draft.meta.title, body: p.body };
    },
    [draft.meta.title],
  );

  if (!section || !draft.folder) return <div className="pane pane-message muted">This book has no chapters to summarize.</div>;

  const isSaved = !!section.saved && section.saved.version === section.current;
  const next = nextUnwritten(draft, index);
  const nextSection = next === null ? null : draft.sections[next];
  const earlierUnsaved = chapters.filter((c) => c.index < index && !c.section.saved).length;
  const status_ = status && <SaveStatus status={status} path={section.path} onOpen={props.onOpenFile} />;
  const kicker = `Chapter ${number} of ${chapters.length} · ${pageRange(section)}`;
  const byline = (
    <div className="reading-byline">
      <button
        className="link-button source-link"
        onClick={() => props.onWikiLink(`${docPath}#page=${section.start}`)}
        title={`${docPath}, page ${section.start}`}
      >
        {draft.meta.title}
      </button>
    </div>
  );

  const changedSince = chaptersChangedSince(draft);
  const overviewSaved = !!overview.saved && overview.saved.version === overview.current;
  const bookByline = (
    <div className="reading-byline">
      {bylineOf(draft.meta) && <span className="byline-authors">{bylineOf(draft.meta)} · </span>}
      <button className="link-button source-link" onClick={() => props.onOpenFile(docPath)} title={docPath}>
        {docPath.split("/").pop()}
      </button>
    </div>
  );
  const overviewPanel =
    overview.versions.length === 0 ? (
      writer.streamed !== null ? (
        <StreamingView text={writer.streamed} onStop={() => writer.running?.cancel()} onWikiLink={props.onWikiLink} waiting="Reading the chapter pages…" />
      ) : (
        <div className="summary-start">
          <div className="kicker">Book overview</div>
          <h2>{draft.meta.title}</h2>
          <p className="muted">
            The AI reads the chapter pages (the saved version of each, else its latest draft) and writes the book's overview: what it
            argues, how the chapters build on each other, and the key concepts. It's saved to <code>{overviewPath(draft.folder)}</code>{" "}
            above the contents.
          </p>
          {writtenCount < chapters.length && (
            <p className="muted">
              {writtenCount === 0
                ? "No chapters are written yet."
                : `Only ${writtenCount} of ${chapters.length} chapters are written so far; the overview will cover those. It's best written once all chapters are saved.`}
            </p>
          )}
          {props.signIn || (
            <div className="row">
              <button className="primary" onClick={() => void writeOverview()} disabled={running || writtenCount === 0}>
                Write the overview
              </button>
            </div>
          )}
          {writer.error && <ErrorLine error={writer.error} />}
          {writer.limitReached && <UsageLimit />}
        </div>
      )
    ) : (
      <DraftView
        key="overview"
        item={overview}
        parse={parseOverview}
        kicker={`Book overview · ${writtenCount} of ${chapters.length} chapters`}
        byline={bookByline}
        writer={writer}
        onSelect={(v) => setOverview((o) => ({ ...o, current: v }))}
        onKeepEdit={(text) => setOverview((o) => ({ ...o, versions: [...o.versions, editVersion(o, text)], current: o.versions.length }))}
        onRevise={(feedback) => writeOverview(feedback)}
        onWikiLink={props.onWikiLink}
        signIn={props.signIn}
        actions={
          <div className="summary-actions">
            {status && <SaveStatus status={status} path={overview.saved?.path} onOpen={props.onOpenFile} />}
            {!status && changedSince > 0 && (
              <span className="muted">
                {changedSince === 1 ? "1 chapter was" : `${changedSince} chapters were`} saved since this was written.{" "}
                <button className="link-button" onClick={() => void writeOverview(UPDATE_FOR_CHAPTERS)} disabled={running || !!props.signIn}>
                  Update for new chapters
                </button>
              </span>
            )}
            <span className="spacer" />
            <button className="primary" onClick={() => void saveOverview()} disabled={saving || running || overviewSaved}>
              {overviewSaved ? "Saved to wiki" : overview.saved ? "Update wiki page" : "Accept and save"}
            </button>
          </div>
        }
      />
    );

  return (
    <>
      <div className="book-bar">
        <button className="icon-button" aria-label="Previous chapter" disabled={position <= 0 || running} onClick={() => select(nav[position - 1])}>
          ◀
        </button>
        <select value={showOverview ? OVERVIEW : index} disabled={running} aria-label="Chapter" onChange={(e) => select(Number(e.target.value))}>
          <option value={OVERVIEW}>
            {overview.saved ? "✓ " : overview.versions.length ? "• " : "\u2003"}
            Overview
          </option>
          {chapters.map((c, n) => (
            <option key={c.index} value={c.index}>
              {c.section.saved ? "✓ " : c.section.versions.length ? "• " : " "}
              {n + 1}. {c.section.title}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="Next chapter"
          disabled={position >= nav.length - 1 || running}
          onClick={() => select(nav[position + 1])}
        >
          ▶
        </button>
        <span className="book-progress muted">
          {savedCount} of {chapters.length} saved
        </span>
        <span className="spacer" />
        <button
          className="link-button"
          onClick={() => props.onOpenFile(overviewPath(draft.folder!))}
          disabled={savedCount === 0 && !overview.saved}
        >
          Overview page
        </button>
        <button onClick={props.onDiscard} disabled={running}>
          Discard
        </button>
      </div>

      {showOverview ? (
        overviewPanel
      ) : section.versions.length === 0 ? (
        writer.streamed !== null ? (
          <StreamingView
            text={writer.streamed}
            onStop={() => writer.running?.cancel()}
            onWikiLink={props.onWikiLink}
            waiting="Reading the chapter…"
          />
        ) : (
          <div className="summary-start">
            <div className="kicker">{kicker}</div>
            <h2>{section.title}</h2>
            <p className="muted">
              The AI reads this chapter ({pageRange(section)}) with the book's contents and the TL;DRs of the chapters before it, and writes its page. You
              review it and save it to <code>{section.path}</code> before moving on.
            </p>
            {earlierUnsaved > 0 && (
              <p className="muted">
                {earlierUnsaved === 1 ? "One earlier chapter isn't" : `${earlierUnsaved} earlier chapters aren't`} saved yet; this
                chapter sees their latest drafts, if any.
              </p>
            )}
            {props.signIn || (
              <div className="row">
                <button className="primary" onClick={() => void write(index)} disabled={running}>
                  Write this chapter
                </button>
              </div>
            )}
            {writer.error && <ErrorLine error={writer.error} />}
            {writer.limitReached && <UsageLimit />}
          </div>
        )
      ) : (
        <DraftView
          key={index}
          item={section}
          parse={parse}
          kicker={kicker}
          byline={byline}
          writer={writer}
          onSelect={(v) => setSection(index, (s) => ({ ...s, current: v }))}
          onKeepEdit={(text) => setSection(index, (s) => ({ ...s, versions: [...s.versions, editVersion(s, text)], current: s.versions.length }))}
          onRevise={(feedback) => write(index, feedback)}
          onWikiLink={props.onWikiLink}
          signIn={props.signIn}
          actions={
            <div className="summary-actions">
              {status_}
              <span className="spacer" />
              {!status && section.saved && (
                <button className="link-button" onClick={() => props.onOpenFile(section.saved!.path)}>
                  {section.saved.path}
                </button>
              )}
              <button
                className={isSaved && nextSection ? "" : "primary"}
                onClick={() => void save(index)}
                disabled={saving || running || isSaved}
              >
                {isSaved ? "Saved to wiki" : section.saved ? "Update wiki page" : "Accept and save"}
              </button>
              {isSaved && nextSection && next !== null && (
                <button className="primary" onClick={() => writeNext(next)} disabled={running || !!props.signIn} title={nextSection.title}>
                  Write next: {chapterNumber(draft, next)}. {truncate(nextSection.title, 32)}
                </button>
              )}
              {isSaved && !nextSection && savedCount === chapters.length && (
                <button className="primary" onClick={() => openOverview(overview.versions.length === 0)} disabled={running || !!props.signIn}>
                  {overview.versions.length === 0 ? "Write the overview" : "Go to the overview"}
                </button>
              )}
            </div>
          }
        />
      )}
    </>
  );
}

/** The request behind "Update for new chapters". */
const UPDATE_FOR_CHAPTERS =
  "Chapters were added or revised since you wrote this overview; my first message now has their current pages. Update the overview to cover them, and keep everything else as it is.";

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
