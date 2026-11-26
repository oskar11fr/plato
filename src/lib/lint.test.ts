import { describe, expect, it } from "vitest";
import {
  applyLinks,
  catalogOf,
  contextOf,
  emptyLintState,
  findPhrase,
  lintPlan,
  logEntry,
  parseLinkReply,
  recordChecked,
  runChecks,
  type WikiPage,
} from "./lint";
import { indexFiles, linkCandidates, linkTarget, resolveWikiLink } from "./wikilinks";

const page = (path: string, text: string): WikiPage => ({ path, text });

const attention = page(
  "wiki/sources/attention.md",
  [
    "---",
    'type: "source-summary"',
    'title: "Attention Is All You Need"',
    'tldr: "The Transformer replaces recurrence with self-attention."',
    'source: "[[papers/attention.pdf]]"',
    "---",
    "",
    "# Attention Is All You Need",
    "",
    "The Transformer uses [[self-attention]] instead of recurrent networks like the LSTM.",
    "Training uses the Adam optimizer, see `Adam` in code and $Adam$ in math.",
    "",
    "## Adam",
    "",
    "| Model | Adam |",
    "|---|---|",
  ].join("\n"),
);
const lstm = page(
  "wiki/concepts/lstm.md",
  '---\ntitle: "Long short-term memory"\naliases: ["LSTM"]\n---\n\n# Long short-term memory\n\nA recurrent network with gates.',
);
const adam = page("wiki/concepts/adam.md", "# Adam\n\nAn optimizer. See [[wiki/sources/attention|the Transformer paper]] and [[ghost/page]].");
const chapterA = page("wiki/sources/book-a/01-introduction.md", '---\ntype: "source-section"\n---\n# Introduction\n\nIntro A.');
const chapterB = page("wiki/sources/book-b/01-introduction.md", "# Introduction\n\nIntro B, links [[01-introduction]].");
const index = page("wiki/index.md", "# Wiki\n\n- [[wiki/sources/gone|Gone]]\n");
const pages = [attention, lstm, adam, chapterA, chapterB, index];
const files = indexFiles([...pages.map((p) => p.path), "papers/attention.pdf"]);

describe("Obsidian-style link resolution", () => {
  it("finds pages by path, by file name anywhere, and falls back to a concept page", () => {
    expect(resolveWikiLink("lstm", files)).toEqual({ path: "wiki/concepts/lstm.md" });
    expect(resolveWikiLink("LSTM", files)).toEqual({ path: "wiki/concepts/lstm.md" });
    expect(resolveWikiLink("attention.pdf#page=3", files)).toEqual({ path: "papers/attention.pdf", page: 3 });
    expect(resolveWikiLink("sources/attention", files)).toEqual({ path: "wiki/sources/attention.md" });
    expect(resolveWikiLink("wiki/sources/attention", files)).toEqual({ path: "wiki/sources/attention.md" });
    expect(resolveWikiLink("not-written", files)).toEqual({ path: "wiki/concepts/not-written.md" });
    expect(linkCandidates("01-introduction", files)).toHaveLength(2);
    expect(linkCandidates("book-b/01-introduction", files)).toEqual(["wiki/sources/book-b/01-introduction.md"]);
  });

  it("links by bare name unless the name is shared", () => {
    expect(linkTarget("wiki/concepts/lstm.md", files)).toBe("lstm");
    expect(linkTarget("wiki/sources/book-a/01-introduction.md", files)).toBe("wiki/sources/book-a/01-introduction");
  });
});

describe("checks", () => {
  const report = runChecks(pages, files);

  it("finds broken, missing and ambiguous links", () => {
    expect(report.broken).toEqual([{ page: "wiki/concepts/adam.md", target: "ghost/page" }]);
    expect(report.missing).toEqual([{ target: "self-attention", pages: ["wiki/sources/attention.md"] }]);
    expect(report.ambiguous.map((a) => [a.page, a.target])).toEqual([["wiki/sources/book-b/01-introduction.md", "01-introduction"]]);
  });

  it("finds orphans, index problems and thin pages", () => {
    expect(report.orphans).toEqual(["wiki/concepts/lstm.md", "wiki/concepts/adam.md", "wiki/sources/book-b/01-introduction.md"]);
    expect(report.index).toEqual({ notListed: ["wiki/sources/attention.md"], listedMissing: ["wiki/sources/gone"] });
    expect(report.thin.map((t) => t.path)).toContain("wiki/concepts/lstm.md");
  });
});

describe("planning", () => {
  const catalog = catalogOf(pages, files);

  it("catalogs pages with titles, aliases and summaries", () => {
    expect(catalog.find((c) => c.path === "wiki/concepts/lstm.md")).toEqual({
      path: "wiki/concepts/lstm.md",
      link: "lstm",
      title: "Long short-term memory",
      aliases: ["LSTM"],
      type: "concepts",
      summary: "A recurrent network with gates.",
    });
    expect(catalog.find((c) => c.path === attention.path)?.summary).toBe("The Transformer replaces recurrence with self-attention.");
    expect(catalog.some((c) => c.path === "wiki/index.md")).toBe(false);
  });

  it("sends new and changed pages, and unchanged ones only for pages added since", () => {
    const withDigests = pages.map((p) => ({ ...p, digest: p.text.length.toString() }));
    const first = lintPlan(withDigests, catalog, emptyLintState());
    expect(first.map((p) => p.reason)).toEqual(["new", "new", "new", "new", "new"]);
    expect(first.find((p) => p.path === "wiki/index.md")).toBeUndefined();

    const older = catalog.filter((c) => c.path !== "wiki/concepts/adam.md");
    let state = recordChecked(emptyLintState(), older, Object.fromEntries(withDigests.map((p) => [p.path, p.digest])));
    const changed = withDigests.map((p) => (p.path === lstm.path ? { ...p, digest: "x" } : p));
    const plan = lintPlan(changed, catalog, state);
    expect(plan.find((p) => p.path === lstm.path)?.reason).toBe("changed");
    const unchanged = plan.find((p) => p.path === attention.path);
    expect(unchanged?.reason).toBe("new pages");
    expect(unchanged?.targets.map((t) => t.path)).toEqual(["wiki/concepts/adam.md"]);

    state = recordChecked(state, catalog, { [lstm.path]: "x" });
    expect(state.runs).toHaveLength(2);
    state = recordChecked(state, catalog, Object.fromEntries(changed.map((p) => [p.path, p.digest])));
    expect(state.runs).toHaveLength(1); // the older runs aren't needed any more
    expect(lintPlan(changed, catalog, state)).toEqual([]);
    expect(lintPlan(changed, catalog, state, true)).toHaveLength(5);
  });
});

describe("suggested links", () => {
  const catalog = catalogOf(pages, files);

  it("keeps only suggestions the app can carry out", () => {
    const reply = JSON.stringify({
      links: [
        { text: "LSTM", target: "lstm", reason: "the concept" },
        { text: "Adam optimizer", target: "[[wiki/concepts/adam]]" },
        { text: "recurrent networks", target: "lstm" }, // same target twice
        { text: "Attention", target: "attention" }, // the page itself
        { text: "Transformer", target: "nowhere" }, // not in the catalog
        { text: "BERT", target: "wiki/sources/book-a/01-introduction" }, // not in the page
      ],
      fixes: [{ link: "self-attention", target: "adam" }],
    });
    const { links, fixes } = parseLinkReply(`Here you go:\n${reply}`, attention, catalog, files);
    expect(links).toEqual([
      { text: "LSTM", target: "lstm", reason: "the concept" },
      { text: "Adam optimizer", target: "adam" },
    ]);
    expect(fixes).toEqual([{ link: "self-attention", target: "adam" }]);
    expect(parseLinkReply(reply, attention, catalog, files).dropped.map((d) => [d.text, d.why])).toEqual([
      ["Attention", "the page itself"],
      ["Transformer", "not a page in the wiki"],
      ["BERT", "phrase not found where a link can go"],
    ]);
    // A page named by its title or an alias works too.
    const byTitle = JSON.stringify({ links: [{ text: "LSTM", target: "Long short-term memory" }] });
    expect(parseLinkReply(byTitle, attention, catalog, files).links).toEqual([{ text: "LSTM", target: "lstm" }]);
    expect(() => parseLinkReply("no json", attention, catalog, files)).toThrow();
  });

  it("finds phrases only where a link can go, as whole words", () => {
    const text = attention.text;
    expect(findPhrase(text, "Adam")).toBe(text.indexOf("Adam optimizer"));
    expect(findPhrase(text, "self-attention")).toBe(-1); // already a link
    expect(findPhrase(text, "Attention Is All")).toBe(-1); // front matter and heading only
    expect(findPhrase("multi-head attention", "head")).toBe(-1);
    expect(findPhrase("Uses the lstm.", "LSTM")).toBe(9);
    expect(contextOf(text, "LSTM")).toEqual({ before: "…former uses [[self-attention]] instead of recurrent networks like the ", match: "LSTM", after: "." });
  });

  it("applies links and fixes, keeping the text", () => {
    const { text, applied, skipped } = applyLinks(
      attention.text,
      [
        { text: "LSTM", target: "lstm" },
        { text: "Adam optimizer", target: "adam" },
        { text: "Transformer", target: "wiki/sources/book-a/01-introduction" },
        { text: "gone phrase", target: "lstm" },
      ],
      [{ link: "self-attention", target: "adam" }],
    );
    expect(applied).toBe(4);
    expect(skipped).toEqual(["gone phrase"]);
    expect(text).toContain("The [[wiki/sources/book-a/01-introduction|Transformer]] uses [[adam|self-attention]] instead of recurrent networks like the [[lstm|LSTM]].");
    expect(text).toContain("Training uses the [[adam|Adam optimizer]], see `Adam` in code and $Adam$ in math.");
    expect(text).toContain("## Adam\n");
    expect(text).toContain('title: "Attention Is All You Need"');
    expect(applyLinks("Uses Adam.", [{ text: "Adam", target: "adam" }]).text).toBe("Uses [[adam|Adam]].");
    expect(applyLinks("Uses adam.", [{ text: "adam", target: "adam" }]).text).toBe("Uses [[adam]].");
  });

  it("writes a log entry", () => {
    const entry = logEntry("2026-11-26", [{ path: "wiki/concepts/lstm.md", links: 2, fixes: 1 }], runChecks(pages, files));
    expect(entry).toBe(
      "## [2026-11-26] lint | 3 links added in 1 page\n- [[wiki/concepts/lstm]]: 2 links, 1 fixed\n- Checks: 1 broken links, 1 ambiguous, 1 pages still to write, 3 orphans, 5 thin pages\n",
    );
  });
});
