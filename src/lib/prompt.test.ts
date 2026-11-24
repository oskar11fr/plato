import { describe, expect, it } from "vitest";
import { MAX_PAGE_TEXT, userMessage } from "./prompt";

const passage = { highlight: "hl-1", page: 4, quote: "scaled dot-product attention" };

describe("userMessage", () => {
  it("passes plain questions through", () => {
    expect(userMessage({ content: "What is attention?" })).toBe("What is attention?");
  });

  it("delimits the passage, adds the page text, then the question", () => {
    expect(userMessage({ content: "Why scale?", passage }, "We call our particular attention scaled dot-product attention.")).toBe(
      [
        "Selected passage (page 4):",
        "<passage>",
        "scaled dot-product attention",
        "</passage>",
        "",
        "Text of page 4, for context:",
        "<page_text>",
        "We call our particular attention scaled dot-product attention.",
        "</page_text>",
        "",
        "Question: Why scale?",
      ].join("\n"),
    );
  });

  it("replays earlier passages without the page text", () => {
    const msg = userMessage({ content: "Why scale?", passage });
    expect(msg).toContain("<passage>\nscaled dot-product attention\n</passage>");
    expect(msg).not.toContain("page_text");
  });

  it("caps very long page text", () => {
    const msg = userMessage({ content: "q", passage }, "x".repeat(MAX_PAGE_TEXT + 500));
    expect(msg).toContain("[…page text truncated]");
    expect(msg.length).toBeLessThan(MAX_PAGE_TEXT + 300);
  });
});
