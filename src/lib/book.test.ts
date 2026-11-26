import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../pdf/text";
import {
  assignPaths,
  chapterNumber,
  metaFromInfo,
  nextUnwritten,
  outlineLevels,
  overviewPageText,
  parseSection,
  sectionPageText,
  sectionPageToDraft,
  sectionRequestMessage,
  sectionsFromOutline,
  suggestLevel,
  withEnds,
  type BookDraft,
} from "./book";
import { parseFrontMatter } from "./frontmatter";
import { wikiIndexText, wikiPageSource } from "./summary";

const node = (title: string, page: number | null, children: OutlineNode[] = []): OutlineNode => ({ title, page, children });

/** `n` pages of `chars` characters each. */
const pagesOf = (n: number, chars = 2000) => Array.from({ length: n }, (_, i) => `page ${i + 1} `.padEnd(chars, "x"));

// A book in two parts: cover, contents, Part I (ch. 1–2), Part II (ch. 3), index.
const outline = [
  node("Cover", 1),
  node("Contents", 2),
  node("Part I", 5, [node("1 Beginnings", 6, [node("1.1 First", 6), node("1.2 Second", 20)]), node("2 Middles", 40)]),
  node("Part II", 80, [node("3 Ends", 81)]),
  node("Index", 118),
];

describe("sections from bookmarks", () => {
  it("counts levels", () => {
    expect(outlineLevels(outline)).toBe(3);
    expect(outlineLevels([])).toBe(0);
  });

  it("takes every bookmark down to the level, with page ranges and sensible defaults", () => {
    const sections = sectionsFromOutline(outline, 1, pagesOf(120));
    expect(sections.map((s) => [s.title, s.start, s.end, s.include])).toEqual([
      ["Cover", 1, 1, false], // front matter
      ["Contents", 2, 4, false],
      ["Part I", 5, 5, false], // has chapters under it
      ["1 Beginnings", 6, 39, true],
      ["2 Middles", 40, 79, true],
      ["Part II", 80, 80, false],
      ["3 Ends", 81, 117, true],
      ["Index", 118, 120, false],
    ]);
  });

  it("excludes near-empty sections like a title page", () => {
    const pages = pagesOf(10);
    pages[0] = "A Story";
    const sections = sectionsFromOutline([node("A Story", 1), node("Prologue", 2)], 0, pages);
    expect(sections.map((s) => s.include)).toEqual([false, true]);
  });

  it("lets sections that start on the same page share it", () => {
    const sections = sectionsFromOutline([node("A", 3, [node("A.1", 3)]), node("B", 9)], 1, pagesOf(10));
    expect(sections.map((s) => [s.title, s.start, s.end])).toEqual([
      ["A", 3, 3],
      ["A.1", 3, 8],
      ["B", 9, 10],
    ]);
  });

  it("skips bookmarks that point nowhere or past the end", () => {
    const sections = sectionsFromOutline([node("Web link", null), node("A", 1), node("Ghost", 99)], 0, pagesOf(10));
    expect(sections.map((s) => s.title)).toEqual(["A"]);
  });

  it("suggests the shallowest level with chapters of a readable size", () => {
    // Parts are ~150k+ characters (too long); chapters at level 1 are fine.
    expect(suggestLevel(outline, pagesOf(120, 2500))).toBe(1);
    // Short pages: the parts are already small enough.
    expect(suggestLevel(outline, pagesOf(120, 500))).toBe(0);
  });

  it("recomputes ends when the reader changes start pages", () => {
    const sections = sectionsFromOutline([node("A", 1), node("B", 10), node("C", 20)], 0, pagesOf(30));
    const moved = withEnds(sections.map((s) => (s.title === "C" ? { ...s, start: 5 } : s)), 30);
    expect(moved.map((s) => [s.title, s.start, s.end])).toEqual([
      ["A", 1, 4],
      ["C", 5, 9],
      ["B", 10, 30],
    ]);
  });
});

function bookDraft(): BookDraft {
  const sections = sectionsFromOutline(outline, 1, pagesOf(120));
  return {
    version: 1,
    kind: "book",
    source: "books/story.pdf",
    meta: { title: "A Story: Told Well", authors: ["Ann Author"], year: 2020 },
    focus: "",
    includeHighlights: true,
    level: 1,
    sections,
    selected: 0,
  };
}

const chapterOutput = [
  "---",
  'title: "2 Middles"',
  'tldr: "The middle drags, on purpose."',
  "---",
  "",
  "# 2 Middles",
  "",
  "**TL;DR** It drags ([[books/story.pdf#page=41|p. 41]]).",
].join("\n");

describe("book drafts", () => {
  it("numbers included sections and gives each a page in the book's folder", () => {
    const draft = assignPaths(bookDraft(), ["a-story-told-well", "other.md"]);
    expect(draft.folder).toBe("wiki/sources/a-story-told-well-2");
    expect(draft.sections.filter((s) => s.include).map((s) => s.path)).toEqual([
      "wiki/sources/a-story-told-well-2/01-1-beginnings.md",
      "wiki/sources/a-story-told-well-2/02-2-middles.md",
      "wiki/sources/a-story-told-well-2/03-3-ends.md",
    ]);
    expect(draft.sections.find((s) => !s.include)?.path).toBeUndefined();
    expect(chapterNumber(draft, 4)).toBe(2);
    expect(chapterNumber(draft, 0)).toBe(0);
    expect(assignPaths(bookDraft(), [], "wiki/sources/kept").sections[3].path).toBe("wiki/sources/kept/01-1-beginnings.md");
  });

  it("finds the next chapter to write", () => {
    const draft = bookDraft();
    const written = [{ text: chapterOutput, by: "ai" as const, at: "t" }];
    expect(nextUnwritten(draft)).toBe(3);
    draft.sections[3].versions = written;
    draft.sections[6].versions = written;
    expect(nextUnwritten(draft, 3)).toBe(4);
    expect(nextUnwritten(draft, 6)).toBe(4); // wraps around to one that was skipped
    draft.sections[4].versions = written;
    expect(nextUnwritten(draft)).toBeNull();
  });

  it("asks for one chapter with the contents and the earlier chapters' TL;DRs", () => {
    const draft = assignPaths(bookDraft(), []);
    draft.sections[3].versions = [
      { text: '---\ntitle: "1 Beginnings"\ntldr: "It starts."\n---\n# 1 Beginnings\n', by: "ai", at: "t" },
    ];
    const pages = pagesOf(120, 20);
    const message = sectionRequestMessage(draft, 4, pages, {
      highlights: [
        { page: 41, quote: "inside" },
        { page: 90, quote: "outside" },
      ],
    });
    expect(message).toContain('<book title="A Story: Told Well" authors="Ann Author" year="2020" path="books/story.pdf" pages="120">');
    expect(message).toContain("1. 1 Beginnings, pp. 6–39: [[wiki/sources/a-story-told-well/01-1-beginnings]]");
    expect(message).toContain("2. 2 Middles, pp. 40–79 (this chapter)");
    expect(message).toContain("1. 1 Beginnings (pp. 6–39): It starts.");
    expect(message).toContain('<page number="40">');
    expect(message).toContain('<page number="79">');
    expect(message).not.toContain('<page number="80">');
    expect(message).toContain('- p. 41: "inside"');
    expect(message).not.toContain("outside");
    expect(message.trim().endsWith('Write the wiki page for chapter 2 of 3, "2 Middles" (pp. 40–79).')).toBe(true);
  });

  it("writes a chapter page that links to its book and reads it back", () => {
    const draft = assignPaths(bookDraft(), []);
    const text = sectionPageText(draft, 4, parseSection(chapterOutput), { created: "c", updated: "u", model: "m" });
    const { front, body } = parseFrontMatter(text);
    expect(front).toMatchObject({
      type: "source-section",
      title: "2 Middles",
      tldr: "The middle drags, on purpose.",
      book: "[[wiki/sources/a-story-told-well/00-overview]]",
      chapter: 2,
      pages: [40, 79],
    });
    expect(wikiPageSource(text)).toBe("books/story.pdf");
    expect(body).toContain("# 2 Middles\n\n*From [[wiki/sources/a-story-told-well/00-overview|A Story: Told Well]], pp. 40–79.*\n\n**TL;DR**");
    const trimmed = (t: string) => ({ ...parseSection(t), body: parseSection(t).body.trim() });
    expect(trimmed(sectionPageToDraft(text))).toEqual(trimmed(chapterOutput));
  });

  it("writes an overview listing saved chapters", () => {
    const draft = assignPaths(bookDraft(), []);
    draft.sections[4] = { ...draft.sections[4], versions: [{ text: chapterOutput, by: "ai", at: "t" }], saved: { path: "x", version: 0, digest: "d" } };
    const text = overviewPageText(draft, { created: "c", updated: "u" });
    expect(parseFrontMatter(text).front).toMatchObject({ type: "source-summary", kind: "book", source: "[[books/story.pdf]]" });
    expect(text).toContain("Author, 2020 · [[books/story.pdf|story.pdf]]");
    expect(text).toContain("1. 1 Beginnings *(not summarized yet)*, pp. 6–39");
    expect(text).toContain("2. [[wiki/sources/a-story-told-well/02-2-middles|2 Middles]], pp. 40–79: The middle drags, on purpose.");
  });

  it("nests a book's chapters in the wiki index", () => {
    const text = wikiIndexText([
      {
        path: "wiki/sources/b/00-overview.md",
        title: "B",
        authors: [],
        year: null,
        chapters: [{ path: "wiki/sources/b/01-one.md", title: "One" }],
      },
    ]);
    expect(text).toContain("- [[wiki/sources/b/00-overview|B]]\n  - [[wiki/sources/b/01-one|One]]\n");
  });

  it("takes book details from PDF metadata, or the file name", () => {
    expect(metaFromInfo({ title: "Real Title", author: "A. One; B. Two" }, "x/file.pdf")).toEqual({
      title: "Real Title",
      authors: ["A. One", "B. Two"],
      year: null,
    });
    expect(metaFromInfo({ title: "Microsoft Word - draft.docx", author: "" }, "x/my_book.pdf").title).toBe("my book");
  });
});
