import { describe, expect, it } from "vitest";
import { chatFileName, parseChat, serializeChat, slugify, titleFrom, type Chat } from "./chats";

const chat: Chat = {
  id: "chat-3f2a91c0",
  title: 'How is "attention" scaled?',
  source: "papers/attention.pdf",
  created: "2026-11-23T14:15:02Z",
  updated: "2026-11-23T14:22:40Z",
  turns: [
    { role: "user", content: "How is attention scaled?", at: "2026-11-23T14:15:02Z" },
    {
      role: "assistant",
      model: "gpt-6.2-sol",
      at: "2026-11-23T14:15:09Z",
      content:
        "## Short answer\n\nBy $\\frac{1}{\\sqrt{d_k}}$:\n\n$$\n\\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V\n$$\n\n### Answer\n\nA heading named like ours must not split the turn.",
    },
    { role: "user", content: "Why not $d_k$?", at: "2026-11-23T14:20:00Z" },
    { role: "assistant", model: "gpt-6.1-sol", at: "2026-11-23T14:22:40Z", content: "Because the variance grows with $d_k$." },
  ],
};

describe("chat files", () => {
  it("round-trips through Markdown", () => {
    expect(parseChat(serializeChat(chat))).toEqual(chat);
  });

  it("writes front matter, a title and a wikilink to the source", () => {
    const md = serializeChat(chat);
    expect(md.startsWith("---\ntype: \"chat\"\nid: \"chat-3f2a91c0\"\n")).toBe(true);
    expect(md).toContain('title: "How is \\"attention\\" scaled?"');
    expect(md).toContain('models: ["gpt-6.2-sol","gpt-6.1-sol"]');
    expect(md).toContain("# How is \"attention\" scaled?\n\nChat about [[papers/attention.pdf]].");
    expect(md).toContain('<!-- plato:turn {"role":"user","at":"2026-11-23T14:15:02Z"} -->\n### Question\n\nHow is attention scaled?');
  });

  it("tolerates hand edits", () => {
    const edited = [
      "---",
      "type: chat",
      "title: Edited by hand",
      "source: papers/attention.pdf",
      "tags: [attention]",
      "---",
      "",
      "Some notes the user added above the turns.",
      "",
      '<!-- plato:turn {"role":"user","at":"t1"} -->',
      "What is a head?",
      "",
      '<!-- plato:turn {"role":"assistant","model":"m","at":"t2"} -->',
      "### Answer",
      "",
      "One attention function.",
    ].join("\r\n");
    const parsed = parseChat(edited);
    expect(parsed.title).toBe("Edited by hand");
    expect(parsed.source).toBe("papers/attention.pdf");
    expect(parsed.id).toMatch(/^chat-/);
    expect(parsed.turns).toEqual([
      { role: "user", content: "What is a head?", at: "t1" },
      { role: "assistant", content: "One attention function.", at: "t2", model: "m" },
    ]);
  });

  it("names files by date and title, avoiding collisions", () => {
    expect(slugify("Ünïcode & LaTeX: $\\sqrt{d_k}$?")).toBe("unicode-latex-sqrt-d-k");
    expect(slugify("???")).toBe("chat");
    expect(chatFileName(chat, [])).toBe("2026-11-23-how-is-attention-scaled.md");
    expect(chatFileName(chat, ["2026-11-23-how-is-attention-scaled.md"])).toBe("2026-11-23-how-is-attention-scaled-2.md");
  });

  it("titles chats from the first question", () => {
    expect(titleFrom("  What is\nattention?  ")).toBe("What is attention?");
    const long = titleFrom("Why does the Transformer use sinusoidal positional encodings instead of learned ones in the base model?");
    expect(long.length).toBeLessThanOrEqual(71);
    expect(long.endsWith("…")).toBe(true);
  });

  it("stores a passage as a cited blockquote and reads it back", () => {
    const withPassage: Chat = {
      ...chat,
      turns: [
        {
          role: "user",
          content: "What does this mean?",
          at: "t1",
          passage: { highlight: "hl-3f2a", page: 1, quote: "We propose a new simple network architecture, the Transformer" },
        },
        { role: "assistant", content: "It replaces recurrence with attention.", at: "t2", model: "m" },
      ],
    };
    const md = serializeChat(withPassage);
    expect(md).toContain(
      '<!-- plato:turn {"role":"user","at":"t1","highlight":"hl-3f2a","page":1} -->\n### Question\n\n' +
        "> We propose a new simple network architecture, the Transformer\n>\n" +
        "> — [[papers/attention.pdf#page=1|attention.pdf, p. 1]]\n\nWhat does this mean?",
    );
    expect(parseChat(md)).toEqual(withPassage);
  });

  it("keeps a typed blockquote in a question without a highlight", () => {
    const md = serializeChat({ ...chat, turns: [{ role: "user", content: "> my own quote\n\nthoughts?", at: "t" }] });
    expect(parseChat(md).turns[0]).toEqual({ role: "user", content: "> my own quote\n\nthoughts?", at: "t" });
  });
});
