import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math";

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( \\) to $ $", () => {
    expect(normalizeMathDelimiters("Scale by \\( \\frac{1}{\\sqrt{d_k}} \\) here.")).toBe(
      "Scale by $\\frac{1}{\\sqrt{d_k}}$ here.",
    );
  });

  it("converts display \\[ \\] to a $$ block", () => {
    expect(normalizeMathDelimiters("Attention is\n\\[\n\\mathrm{softmax}(QK^T)V\n\\]\ndone")).toBe(
      "Attention is\n\n$$\n\\mathrm{softmax}(QK^T)V\n$$\n\ndone",
    );
  });

  it("leaves dollar math alone", () => {
    const md = "Inline $a^2$ and\n\n$$\nb^2\n$$";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("does not touch code spans or fenced code", () => {
    const md = "Use `\\(x\\)` literally.\n\n```latex\n\\[ y \\]\n```\n\nBut \\(z\\) is math.";
    expect(normalizeMathDelimiters(md)).toBe(
      "Use `\\(x\\)` literally.\n\n```latex\n\\[ y \\]\n```\n\nBut $z$ is math.",
    );
  });

  it("keeps an unclosed fence (mid-stream) as code", () => {
    const md = "Example:\n```python\nprint('\\(x\\)')";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("leaves an unclosed delimiter (mid-stream) as text", () => {
    expect(normalizeMathDelimiters("So \\( x + ")).toBe("So \\( x + ");
  });
});
