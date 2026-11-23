// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findQuote, offsetsToRange, quoteAt, rangeToOffsets, readPageText } from "./anchoring";

/** A text layer shaped like pdf.js output: one span per text run, <br> at line ends. */
function textLayer(html: string) {
  const div = document.createElement("div");
  div.className = "textLayer";
  div.innerHTML = html;
  document.body.append(div);
  return div;
}

describe("readPageText", () => {
  it("joins spans and turns <br> into newlines", () => {
    const layer = textLayer(
      '<span>We call our particular attention</span><br><span>scaled dot-product</span><span> attention.</span><div class="endOfContent"></div>',
    );
    expect(readPageText(layer).text).toBe(
      "We call our particular attention\nscaled dot-product attention.",
    );
  });
});

describe("offsets <-> range", () => {
  const layer = textLayer("<span>Hello brave</span><br><span>new world</span>");
  const page = readPageText(layer);

  it("round-trips a selection that crosses a line break", () => {
    const start = page.text.indexOf("brave");
    const end = page.text.indexOf("world");
    const range = offsetsToRange(page, start, end)!;
    expect(range.toString()).toBe("bravenew "); // Range.toString ignores <br>
    expect(rangeToOffsets(page, range)).toEqual({ start, end });
  });

  it("maps element boundary points to the next text", () => {
    const range = document.createRange();
    const secondSpan = layer.querySelectorAll("span")[1];
    range.setStart(layer, Array.from(layer.childNodes).indexOf(secondSpan));
    range.setEnd(secondSpan.firstChild!, 3);
    expect(rangeToOffsets(page, range)).toEqual({ start: 12, end: 15 });
  });

  it("maps a boundary after the last node to the end of the page", () => {
    const range = document.createRange();
    range.setStart(layer.querySelector("span")!.firstChild!, 0);
    range.setEnd(layer, layer.childNodes.length);
    expect(rangeToOffsets(page, range).end).toBe(page.text.length);
  });
});

describe("quoteAt", () => {
  it("collapses whitespace and takes context around the quote", () => {
    const page = readPageText(textLayer("<span>We call our particular</span><br><span>attention scaled dot-product attention. The input</span>"));
    const start = page.text.indexOf("scaled");
    const end = start + "scaled dot-product attention".length;
    expect(quoteAt(page, start, end)).toEqual({
      quote: "scaled dot-product attention",
      prefix: "e call our particular attention", // last 32 chars before the quote
      suffix: ". The input",
    });
  });
});

describe("findQuote", () => {
  it("ignores whitespace differences and maps back to original offsets", () => {
    const text = "We call our\nparticular   attention scaled";
    const found = findQuote(text, "our particular attention")!;
    expect(text.slice(found.start, found.end)).toBe("our\nparticular   attention");
  });

  it("uses prefix and suffix to pick among repeated quotes", () => {
    const text = "the model uses attention here. Later, multi-head attention is defined.";
    const found = findQuote(text, "attention", "multi-head", "is defined")!;
    expect(found.start).toBe(text.lastIndexOf("attention"));
    const first = findQuote(text, "attention", "the model uses", "here")!;
    expect(first.start).toBe(text.indexOf("attention"));
  });

  it("returns null when the quote is gone", () => {
    expect(findQuote("nothing to see", "attention")).toBeNull();
    expect(findQuote("anything", "   ")).toBeNull();
  });
});
