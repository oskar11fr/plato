// What the model sees. The system prompt is fixed per document (cache
// friendly); each user turn carries its passage, and the newest one also the
// full page text as context.
import type { ChatTurn, Passage } from "./chats";

/** A page is usually a few thousand characters; cap pathological ones. */
export const MAX_PAGE_TEXT = 20_000;

export const systemPrompt = (docPath: string) =>
  `You are a reading assistant in a research reader app. The user is reading "${docPath}" and asks questions about it. ` +
  `Answer clearly and concisely. When you rely on the text, quote the exact passage.\n\n` +
  `When a question comes with a selected passage, answer about that passage. The page text is context for finding ` +
  `what the passage refers to; don't summarize the whole page unless asked.\n\n` +
  `Format answers in Markdown. Write all mathematics in LaTeX: $...$ for inline math and $$...$$ on their own lines for display equations.`;

/** The default question when the user sends a passage without typing one. */
export const DEFAULT_PASSAGE_QUESTION = "Explain this passage.";

/** Turn a user turn into the message text sent to the model. */
export function userMessage(turn: Pick<ChatTurn, "content" | "passage">, pageText?: string): string {
  if (!turn.passage) return turn.content;
  return passageMessage(turn.passage, turn.content, pageText);
}

function passageMessage(p: Passage, question: string, pageText?: string): string {
  const parts = [`Selected passage (page ${p.page}):`, "<passage>", p.quote, "</passage>"];
  if (pageText?.trim()) {
    const text = pageText.length > MAX_PAGE_TEXT ? `${pageText.slice(0, MAX_PAGE_TEXT)}\n[…page text truncated]` : pageText;
    parts.push("", `Text of page ${p.page}, for context:`, "<page_text>", text.trim(), "</page_text>");
  }
  parts.push("", `Question: ${question}`);
  return parts.join("\n");
}
