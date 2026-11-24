import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "./frontmatter";
import { builtInSkill } from "./skills";
import {
  byline,
  changedBlocks,
  draftText,
  parseDraft,
  revisionMessages,
  splitBlocks,
  summaryFileName,
  summaryRequestMessage,
  summarySystemPrompt,
  wikiIndexText,
  wikiPageSource,
  wikiPageText,
  wikiPageToDraft,
  type SummaryVersion,
} from "./summary";
import { linkifyWikiLinks, resolveWikiLink } from "./wikilinks";

const modelOutput = [
  "---",
  'title: "Attention Is All You Need"',
  'authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]',
  "year: 2017",
  "---",
  "",
  "# Attention Is All You Need",
  "",
  "**TL;DR** The [[Transformer]] drops recurrence ([[papers/attention.pdf#page=1|p. 1]]).",
].join("\n");

describe("front matter", () => {
  it("reads JSON values, plain scalars and block lists", () => {
    const { front, body } = parseFrontMatter("---\ntitle: Plain title\nyear: 2017\nauthors:\n  - A. One\n  - B. Two\n---\nBody");
    expect(front).toEqual({ title: "Plain title", year: 2017, authors: ["A. One", "B. Two"] });
    expect(body).toBe("Body");
  });
});

describe("summary drafts", () => {
  it("parses the model's page", () => {
    const { meta, body } = parseDraft(modelOutput);
    expect(meta).toEqual({ title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"], year: 2017 });
    expect(body.startsWith("# Attention Is All You Need\n")).toBe(true);
  });

  it("handles a page wrapped in a code fence, and front matter still streaming", () => {
    expect(parseDraft("```markdown\n" + modelOutput + "\n```").meta.year).toBe(2017);
    expect(parseDraft('---\ntitle: "Atten').body).toBe("");
  });

  it("writes a wiki page with the app's metadata and reads it back", () => {
    const page = wikiPageText(parseDraft(modelOutput), {
      source: "papers/attention.pdf",
      created: "2026-11-24T10:00:00.000Z",
      updated: "2026-11-24T10:05:00.000Z",
      model: "gpt-x",
    });
    expect(page.startsWith('---\ntype: "source-summary"\ntitle: "Attention Is All You Need"\n')).toBe(true);
    expect(page).toContain('source: "[[papers/attention.pdf]]"');
    expect(wikiPageSource(page)).toBe("papers/attention.pdf");
    const back = parseDraft(wikiPageToDraft(page));
    expect(back.meta.title).toBe("Attention Is All You Need");
    expect(back.body).toBe(parseDraft(modelOutput).body.trim() + "\n");
  });

  it("adds a title heading when the body has none", () => {
    const page = wikiPageText(
      { meta: { title: "T", authors: [], year: null }, body: "Just text." },
      { source: "a.pdf", created: "c", updated: "u" },
    );
    expect(page).toContain("---\n\n# T\n\nJust text.\n");
    expect(page).not.toContain("model:");
  });

  it("names files after the title, uniquely", () => {
    expect(summaryFileName("Attention Is All You Need", [])).toBe("attention-is-all-you-need.md");
    expect(summaryFileName("Attention Is All You Need", ["attention-is-all-you-need.md"])).toBe("attention-is-all-you-need-2.md");
    expect(summaryFileName("???", [])).toBe("summary.md");
  });

  it("puts the document first and the request last", () => {
    const msg = summaryRequestMessage("a.pdf", ["Page one.", "", "Page three."], {
      focus: "the method",
      highlights: [{ page: 3, quote: "Page\nthree" }],
    });
    expect(msg.startsWith('<document path="a.pdf" pages="3">\n<page number="1">\nPage one.\n</page>\n<page number="3">')).toBe(true);
    expect(msg).toContain('- p. 3: "Page three"');
    expect(msg).toContain("Focus: the method");
    expect(msg.endsWith("Write the wiki page summarizing this document.")).toBe(true);
  });

  it("builds the system prompt from the fixed format and the skill", () => {
    const prompt = summarySystemPrompt("papers/a.pdf", builtInSkill("summarize-source"));
    expect(prompt).toContain("[[papers/a.pdf#page=3|p. 3]]");
    expect(prompt).toContain('skill "summarize-source"');
    expect(prompt).toContain("## Accuracy");
    expect(prompt).not.toContain("description:");
  });
});

describe("revisions", () => {
  const v = (text: string, by: SummaryVersion["by"], extra: Partial<SummaryVersion> = {}): SummaryVersion => ({ text, by, at: "t", ...extra });

  it("replays the chain of versions that led to the shown one", () => {
    const versions = [
      v("draft 1", "ai"),
      v("draft 2", "ai", { basedOn: 0, feedback: "shorter" }),
      v("draft 3", "ai", { basedOn: 1, feedback: "add results" }),
      v("draft 2b", "ai", { basedOn: 1, feedback: "more math" }), // branched from version 2
    ];
    expect(revisionMessages("REQ", versions, 3, "fix typo")).toEqual([
      { role: "user", content: "REQ" },
      { role: "assistant", content: "draft 1" },
      { role: "user", content: "shorter" },
      { role: "assistant", content: "draft 2" },
      { role: "user", content: "more math" },
      { role: "assistant", content: "draft 2b" },
      { role: "user", content: "fix typo" },
    ]);
  });

  it("puts hand edits and saved pages in place of the model's reply", () => {
    const versions = [v("wiki page", "wiki"), v("edited", "edit", { basedOn: 0 })];
    expect(revisionMessages("REQ", versions, 1, "shorter")).toEqual([
      { role: "user", content: "REQ" },
      { role: "assistant", content: "edited" },
      { role: "user", content: "I edited the page by hand; keep my edits unless I ask otherwise.\n\nshorter" },
    ]);
  });
});

describe("changes between versions", () => {
  it("keeps code and display math blocks whole", () => {
    expect(splitBlocks("a\nb\n\n$$\nx\n\ny\n$$\n\n```\n1\n\n2\n```\n\nend")).toEqual(["a\nb", "$$\nx\n\ny\n$$", "```\n1\n\n2\n```", "end"]);
  });

  it("marks new and changed blocks", () => {
    expect(changedBlocks("# T\n\nOne.\n\nTwo.", "# T\n\nOne.\n\nTwo, revised.\n\nThree.")).toEqual([
      { block: "# T", changed: false },
      { block: "One.", changed: false },
      { block: "Two, revised.", changed: true },
      { block: "Three.", changed: true },
    ]);
  });
});

describe("wiki index", () => {
  it("lists source pages by title with a byline", () => {
    const text = wikiIndexText([
      { path: "wiki/sources/b.md", title: "Beta", authors: ["Ann Lee"], year: 2020 },
      { path: "wiki/sources/a.md", title: "Alpha", authors: ["A. Vaswani", "N. Shazeer", "N. Parmar"], year: 2017 },
    ]);
    expect(text).toContain("- [[wiki/sources/a|Alpha]] (Vaswani et al., 2017)\n- [[wiki/sources/b|Beta]] (Lee, 2020)");
    expect(byline({ authors: ["A B", "C D"], year: null })).toBe("B and D");
  });
});

describe("wiki links", () => {
  it("become Markdown links, but not inside code", () => {
    expect(linkifyWikiLinks("See [[papers/a b.pdf#page=3|p. 3]] and [[self-attention]], not `[[x]]`.")).toBe(
      "See [p. 3](wikilink:papers%2Fa%20b.pdf%23page%3D3) and [self-attention](wikilink:self-attention), not `[[x]]`.",
    );
    expect(linkifyWikiLinks("[[wiki/sources/a]]")).toBe("[a](wikilink:wiki%2Fsources%2Fa)");
  });

  it("resolve to files, pages and concept pages", () => {
    expect(resolveWikiLink("papers/a.pdf#page=3")).toEqual({ path: "papers/a.pdf", page: 3 });
    expect(resolveWikiLink("wiki/sources/a")).toEqual({ path: "wiki/sources/a.md" });
    expect(resolveWikiLink("self-attention")).toEqual({ path: "wiki/concepts/self-attention.md" });
  });
});

describe("draft text", () => {
  it("round-trips metadata", () => {
    const text = draftText({ title: "T", authors: ["A"], year: 2001 }, "# T\n\nBody");
    expect(parseDraft(text)).toEqual({ meta: { title: "T", authors: ["A"], year: 2001 }, body: "# T\n\nBody\n" });
  });
});
