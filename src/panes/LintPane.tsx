// Lint the wiki: checks for broken links, missing pages, orphans and the
// index, and links the model suggests between pages, reviewed and ticked
// before anything is written.
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ModelPicker, SignInNotice, UsageFooter, useAssistant } from "../components/Assistant";
import { ErrorLine, UsageLimit } from "../components/DraftView";
import { readTextFile, writeTextFile } from "../lib/backend";
import { filesChanged } from "../lib/bus";
import {
  applyLinks,
  catalogOf,
  contextOf,
  linkRequestMessage,
  linkSystemPrompt,
  lintPlan,
  LOG_FILE,
  logEntry,
  parseLinkReply,
  problemCount,
  recordChecked,
  runChecks,
  type CatalogEntry,
  type Dropped,
  type LinkFix,
  type LinkProposal,
  type LintReport,
  type LintState,
  type WikiPage,
} from "../lib/lint";
import { ask, SIGN_IN_ERRORS, toLlmError, USAGE_LIMIT, type AskHandle, type LlmError } from "../lib/llm";
import { INDEX_FILE } from "../lib/summary";
import { appendLog, digest, listWikiPages, loadLintState, saveLintState, updateWikiIndex } from "../lib/wiki";
import { currentFileIndex, findWikiLinks, linkCandidates } from "../lib/wikilinks";
import { openFile, openSettings } from "./open";

type Page = WikiPage & { digest: string };

interface Proposed {
  /** The page's digest when it was checked. */
  digest: string;
  links: (LinkProposal & { on: boolean; context: NonNullable<ReturnType<typeof contextOf>> })[];
  fixes: (LinkFix & { on: boolean })[];
}

interface Loaded {
  pages: Page[];
  catalog: CatalogEntry[];
  report: LintReport;
}

async function loadWiki(): Promise<Loaded> {
  const files = currentFileIndex();
  const pages = await Promise.all((await listWikiPages()).map(async (p) => ({ ...p, digest: await digest(p.text) })));
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, catalog: catalogOf(pages, files), report: runChecks(pages, files) };
}

/** Links in a page that lead nowhere and aren't paths (pages still to write, or misspelled ones). */
function deadLinks(page: WikiPage): string[] {
  const names = findWikiLinks(page.text)
    .map((l) => l.target.split("#")[0].trim())
    .filter((t) => t && !t.includes("/") && !/\.[a-z0-9]{1,6}$/i.test(t) && linkCandidates(t).length === 0);
  return [...new Set(names)];
}

/** Ask the model for one reply and collect its text. */
function askText(request: Parameters<typeof ask>[0], onHandle: (h: AskHandle) => void): Promise<string> {
  let text = "";
  const handle = ask(request, (event) => {
    if (event.type === "textDelta") text += event.text;
  });
  onHandle(handle);
  return handle.done.then(() => text);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function LintPane({ containerApi }: IDockviewPanelProps) {
  const { auth, checkAuth, models, model, setModel } = useAssistant();
  const [wiki, setWiki] = useState<Loaded | null>(null);
  const [lintState, setLintState] = useState<LintState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [proposals, setProposals] = useState<Record<string, Proposed>>({});
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [failures, setFailures] = useState<{ path: string; message: string }[]>([]);
  /** What the last run found, and the suggestions it couldn't use. */
  const [summary, setSummary] = useState<{ pages: number; kept: number; dropped: (Dropped & { path: string })[] } | null>(null);
  const [error, setError] = useState<LlmError | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const running = useRef<{ handle: AskHandle | null; stopped: boolean } | null>(null);
  const stateRef = useRef<LintState | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [loaded, state] = await Promise.all([loadWiki(), loadLintState()]);
      setWiki(loaded);
      setLintState(state);
      stateRef.current = state;
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      running.current?.handle?.cancel();
      if (running.current) running.current.stopped = true;
    };
  }, [reload]);

  const open = (path: string) => openFile(containerApi, path);
  const titleOf = (link: string) => wiki?.catalog.find((c) => c.link === link)?.title ?? link;

  async function remember(digests: Record<string, string>) {
    if (!wiki || !stateRef.current) return;
    const next = recordChecked(stateRef.current, wiki.catalog, digests);
    stateRef.current = next;
    setLintState(next);
    await saveLintState(next).catch(() => {});
  }

  async function suggest() {
    if (!wiki || !stateRef.current || running.current) return;
    const plan = lintPlan(wiki.pages, wiki.catalog, stateRef.current, all).filter((p) => !proposals[p.path]);
    if (plan.length === 0) {
      setMessage("Every page has been checked against the current pages.");
      return;
    }
    setMessage(null);
    setError(null);
    setLimitReached(false);
    setFailures([]);
    setSummary(null);
    let checked = 0;
    let kept = 0;
    const droppedAll: (Dropped & { path: string })[] = [];
    const run = { handle: null as AskHandle | null, stopped: false };
    running.current = run;
    const system = linkSystemPrompt();
    const files = currentFileIndex();
    try {
      for (const [n, item] of plan.entries()) {
        if (run.stopped) break;
        const page = wiki.pages.find((p) => p.path === item.path);
        if (!page) continue;
        setProgress({ done: n, total: plan.length, current: wiki.catalog.find((c) => c.path === page.path)?.title ?? page.path });
        const request = linkRequestMessage(page, item.targets, deadLinks(page), item.reason === "new pages");
        let reply: string;
        try {
          reply = await askText({ model: model ?? undefined, system, messages: [{ role: "user", content: request }] }, (h) => (run.handle = h));
        } catch (err) {
          const e = toLlmError(err);
          if (e.kind === "cancelled") break;
          if (e.kind === USAGE_LIMIT || SIGN_IN_ERRORS.has(e.kind)) {
            setError(e);
            if (e.kind === USAGE_LIMIT) setLimitReached(true);
            else checkAuth();
            break;
          }
          setFailures((f) => [...f, { path: page.path, message: e.message }]);
          continue;
        }
        try {
          const { links, fixes, dropped } = parseLinkReply(reply, page, item.targets, files);
          checked++;
          kept += links.length + fixes.length;
          droppedAll.push(...dropped.map((d) => ({ ...d, path: page.path })));
          if (links.length === 0 && fixes.length === 0) {
            // Nothing to link: done with this page, unless suggestions were dropped (then it stays due, to retry).
            if (dropped.length === 0) await remember({ [page.path]: page.digest });
            continue;
          }
          const withContext = links.flatMap((l) => {
            const context = contextOf(page.text, l.text);
            return context ? [{ ...l, on: true, context }] : [];
          });
          setProposals((p) => ({ ...p, [page.path]: { digest: page.digest, links: withContext, fixes: fixes.map((f) => ({ ...f, on: true })) } }));
        } catch (e) {
          setFailures((f) => [...f, { path: page.path, message: e instanceof Error ? e.message : String(e) }]);
        }
      }
    } finally {
      running.current = null;
      setProgress(null);
      if (checked > 0) setSummary({ pages: checked, kept, dropped: droppedAll });
    }
  }

  function stop() {
    if (!running.current) return;
    running.current.stopped = true;
    running.current.handle?.cancel();
  }

  function toggle(path: string, kind: "links" | "fixes", i: number) {
    setProposals((all) => {
      const p = all[path];
      const items = p[kind].map((x, j) => (j === i ? { ...x, on: !x.on } : x));
      return { ...all, [path]: { ...p, [kind]: items } };
    });
  }

  function toggleAll(path: string, on: boolean) {
    setProposals((all) => {
      const p = all[path];
      return { ...all, [path]: { ...p, links: p.links.map((l) => ({ ...l, on })), fixes: p.fixes.map((f) => ({ ...f, on })) } };
    });
  }

  async function apply() {
    if (!wiki) return;
    setApplying(true);
    setMessage(null);
    const changes: { path: string; links: number; fixes: number }[] = [];
    const digests: Record<string, string> = {};
    const skipped: string[] = [];
    try {
      for (const [path, p] of Object.entries(proposals)) {
        const links = p.links.filter((l) => l.on);
        const fixes = p.fixes.filter((f) => f.on);
        const text = await readTextFile(path);
        if (links.length + fixes.length === 0) {
          digests[path] = await digest(text);
          continue;
        }
        const result = applyLinks(text, links, fixes);
        skipped.push(...result.skipped.map((s) => `“${s}” in ${path}`));
        if (result.text !== text) await writeTextFile(path, result.text);
        digests[path] = await digest(result.text);
        changes.push({ path, links: links.length - result.skipped.length, fixes: result.applied - (links.length - result.skipped.length) });
      }
      const after = await loadWiki();
      const total = changes.reduce((n, c) => n + c.links + c.fixes, 0);
      if (total > 0) await appendLog(logEntry(new Date().toISOString().slice(0, 10), changes, after.report));
      await remember(digests);
      setProposals({});
      filesChanged.emit([...changes.map((c) => c.path), LOG_FILE]);
      await reload();
      setMessage(
        total > 0
          ? `Added ${plural(total, "link")} in ${plural(changes.filter((c) => c.links + c.fixes > 0).length, "page")}.${skipped.length ? ` Skipped ${skipped.join(", ")}: no longer in the page.` : ""}`
          : "No links added.",
      );
    } catch (e) {
      setMessage(`Not applied: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  }

  async function rebuildIndex() {
    await updateWikiIndex();
    filesChanged.emit([INDEX_FILE]);
    await reload();
  }

  if (loadError) return <div className="pane pane-message error">{loadError}</div>;
  if (!wiki || !lintState || !auth) return <div className="pane pane-message muted">Reading the wiki…</div>;

  const plan = lintPlan(wiki.pages, wiki.catalog, lintState, all).filter((p) => !proposals[p.path]);
  const counts = { new: 0, changed: 0, "new pages": 0, again: 0 };
  for (const p of plan) counts[p.reason]++;
  const planText = [
    counts.new && `${counts.new} not checked before`,
    counts.changed && `${counts.changed} changed`,
    counts["new pages"] && `${counts["new pages"]} for links to new pages`,
    counts.again && `${counts.again} again`,
  ]
    .filter(Boolean)
    .join(", ");
  const selected = Object.values(proposals).reduce((n, p) => n + p.links.filter((l) => l.on).length + p.fixes.filter((f) => f.on).length, 0);
  const proposedPages = Object.entries(proposals);
  const { report } = wiki;
  const busy = !!progress || applying;

  return (
    <div className="lint-pane">
      <div className="lint-body">
        <header className="lint-head">
          <h2>Lint the wiki</h2>
          <p className="muted">
            {plural(wiki.catalog.length, "page")} in <code>wiki/</code>.{" "}
            <button className="link-button" onClick={() => void reload()} disabled={busy}>
              Check again
            </button>
          </p>
        </header>

        <section className="lint-section">
          <h3>Links</h3>
          <p className="muted">
            The AI reads each page with a list of the other pages and suggests where to link them. You tick the ones to keep;
            nothing changes until you apply them.
          </p>
          {wiki.catalog.length < 2 ? (
            <p className="muted">The wiki needs at least two pages to link.</p>
          ) : !auth.ready ? (
            <SignInNotice status={auth} onSignedIn={checkAuth} onOpenSettings={() => openSettings(containerApi)} purpose="suggest links" />
          ) : progress ? (
            <div className="lint-progress">
              <span>
                Checking {progress.done + 1} of {progress.total}: {progress.current}…
              </span>
              <button className="link-button" onClick={stop}>
                Stop
              </button>
            </div>
          ) : (
            <div className="lint-controls">
              <button className="primary" onClick={() => void suggest()} disabled={busy || plan.length === 0}>
                Suggest links
              </button>
              <span className="muted">
                {plan.length ? `${plural(plan.length, "page")} to check (${planText}), one request each` : "Every page is up to date."}
              </span>
              <label className="checkbox small">
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                Check all pages again
              </label>
            </div>
          )}
          {error && <ErrorLine error={error} />}
          {limitReached && <UsageLimit />}
          {failures.map((f) => (
            <p key={f.path} className="error small">
              {f.path}: {f.message}
            </p>
          ))}
          {summary && (
            <div className="lint-summary">
              <p className={summary.kept ? "ok" : "muted"}>
                Checked {plural(summary.pages, "page")}:{" "}
                {summary.kept ? `${plural(summary.kept, "link")} to review below` : "no links to suggest"}
                {summary.dropped.length ? `, ${summary.dropped.length} suggestion${summary.dropped.length === 1 ? "" : "s"} couldn't be used` : ""}.
              </p>
              {summary.dropped.length > 0 && (
                <details>
                  <summary className="small">Suggestions that couldn't be used</summary>
                  <ul>
                    {summary.dropped.map((d, i) => (
                      <li key={i} className="small">
                        “{d.text}” → <code>{d.target}</code> <span className="muted">in {d.path.replace(/^wiki\//, "")}: {d.why}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {proposedPages.map(([path, p]) => {
            const allOn = p.links.every((l) => l.on) && p.fixes.every((f) => f.on);
            return (
            <div key={path} className="lint-page">
              <div className="lint-page-head">
                <button className="link-button" onClick={() => open(path)} title={path}>
                  {wiki.catalog.find((c) => c.path === path)?.title ?? path}
                </button>
                <span className="muted">{path}</span>
                <span className="spacer" />
                <button className="link-button small" onClick={() => toggleAll(path, !allOn)}>
                  {allOn ? "None" : "All"}
                </button>
              </div>
              <ul>
                {p.links.map((l, i) => (
                  <li key={`l${i}`}>
                    <label className="checkbox">
                      <input type="checkbox" checked={l.on} onChange={() => toggle(path, "links", i)} />
                      <span className="lint-context">
                        {l.context.before}
                        <mark>{l.context.match}</mark>
                        {l.context.after}
                      </span>
                    </label>
                    <span className="lint-target" title={l.reason}>
                      → {titleOf(l.target)}
                    </span>
                  </li>
                ))}
                {p.fixes.map((f, i) => (
                  <li key={`f${i}`}>
                    <label className="checkbox">
                      <input type="checkbox" checked={f.on} onChange={() => toggle(path, "fixes", i)} />
                      <span className="lint-context">
                        Fix <code>[[{f.link}]]</code>, which leads nowhere
                      </span>
                    </label>
                    <span className="lint-target">→ {titleOf(f.target)}</span>
                  </li>
                ))}
              </ul>
            </div>
            );
          })}
          {message && <p className={message.startsWith("Not applied") ? "error" : "ok"}>{message}</p>}
        </section>

        <section className="lint-section">
          <h3>
            Checks <span className="muted">· {problemCount(report) ? plural(problemCount(report), "problem") : "no problems"}</span>
          </h3>
          <Check title="Broken links" note="Links to a file that doesn't exist, e.g. a document that was moved or deleted." items={report.broken}>
            {(b) => (
              <>
                <PageLink path={b.page} onOpen={open} /> links to <code>[[{b.target}]]</code>
              </>
            )}
          </Check>
          <Check
            title="Ambiguous links"
            note="Names that match more than one file. Link with the path (e.g. book/01-introduction) to say which."
            items={report.ambiguous}
          >
            {(a) => (
              <>
                <PageLink path={a.page} onOpen={open} />: <code>[[{a.target}]]</code> could be {a.candidates.join(" or ")}
              </>
            )}
          </Check>
          <Check
            title="Index"
            note="Source pages missing from wiki/index.md, and index entries for pages that don't exist."
            items={[...report.index.notListed.map((p) => ({ p, missing: false })), ...report.index.listedMissing.map((p) => ({ p, missing: true }))]}
            action={
              <button className="link-button" onClick={() => void rebuildIndex()} disabled={busy}>
                Rebuild the index
              </button>
            }
          >
            {(e) => (e.missing ? <>Lists <code>{e.p}</code>, which doesn't exist</> : <><PageLink path={e.p} onOpen={open} /> isn't listed</>)}
          </Check>
          <Check title="Orphan pages" note="Pages no other page links to." items={report.orphans} level="info">
            {(path) => <PageLink path={path} onOpen={open} />}
          </Check>
          <Check title="Pages to write" note="Linked by name but not written yet (e.g. concept pages)." items={report.missing} level="info">
            {(m) => (
              <>
                <code>[[{m.target}]]</code>{" "}
                <span className="muted">
                  from {m.pages.length === 1 ? <PageLink path={m.pages[0]} onOpen={open} /> : plural(m.pages.length, "page")}
                </span>
              </>
            )}
          </Check>
          <Check title="Thin pages" note="Pages with very little text." items={report.thin} level="info">
            {(t) => (
              <>
                <PageLink path={t.path} onOpen={open} /> <span className="muted">({plural(t.words, "word")})</span>
              </>
            )}
          </Check>
        </section>
      </div>
      {proposedPages.length > 0 && (
        <div className="lint-apply">
          <span className="muted">
            {plural(selected, "link")} ticked in {plural(proposedPages.length, "page")}
          </span>
          <span className="spacer" />
          <button onClick={() => setProposals({})} disabled={busy}>
            Discard suggestions
          </button>
          <button className="primary" onClick={() => void apply()} disabled={busy || !!progress}>
            {selected ? `Apply ${plural(selected, "link")}` : "Apply (add none)"}
          </button>
        </div>
      )}
      <div className="chat-footer">
        <ModelPicker models={models} model={model} onChange={setModel} />
        <UsageFooter />
      </div>
    </div>
  );
}

function PageLink({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  return (
    <button className="link-button" onClick={() => onOpen(path)} title={path}>
      {path.replace(/^wiki\//, "").replace(/\.md$/, "")}
    </button>
  );
}

const SHOWN = 12;

function Check<T>({
  title,
  note,
  items,
  level = "problem",
  action,
  children,
}: {
  title: string;
  note: string;
  items: T[];
  level?: "problem" | "info";
  action?: ReactNode;
  children: (item: T) => ReactNode;
}) {
  const [more, setMore] = useState(false);
  const shown = more ? items : items.slice(0, SHOWN);
  return (
    <details className={`lint-check ${items.length && level === "problem" ? "has-problems" : ""}`} open={items.length > 0 && level === "problem"}>
      <summary>
        <span>{title}</span> <span className="lint-count">{items.length}</span>
      </summary>
      <p className="muted small">
        {note} {items.length > 0 && action}
      </p>
      {items.length > 0 && (
        <ul>
          {shown.map((item, i) => (
            <li key={i}>{children(item)}</li>
          ))}
        </ul>
      )}
      {items.length > SHOWN && (
        <button className="link-button small" onClick={() => setMore(!more)}>
          {more ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </details>
  );
}
