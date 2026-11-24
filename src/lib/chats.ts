// Chats are plain Markdown files, one per conversation, grouped per document:
//
//   .reader/chats/<document path>/<YYYY-MM-DD>-<title-slug>.md
//
// Each file has YAML front matter (every value is written as JSON, which is
// valid YAML), a title, a [[wikilink]] to its source document, and the turns
// in order. A machine-readable HTML comment opens each turn, so the file reads
// naturally as Markdown, survives answers that contain their own headings,
// and can later be turned into wiki pages with links back to the papers.
import { listDir, READER_DIR, readTextFile, readTextFileOpt, writeTextFile, deleteAppFile } from "./backend";

export const CHATS_DIR = `${READER_DIR}/chats`;

/** A passage the question is about (a highlight in the source document). */
export interface Passage {
  highlight: string;
  page: number;
  quote: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  /** The question or answer text (for a user turn, without the passage). */
  content: string;
  passage?: Passage;
  /** ISO time the turn was written. */
  at: string;
  /** Model that wrote an assistant turn. */
  model?: string;
}

export interface Chat {
  id: string;
  title: string;
  /** Workspace-relative path of the document the chat is about. */
  source: string;
  created: string;
  updated: string;
  turns: ChatTurn[];
}

export interface ChatSummary {
  /** Workspace-relative path of the chat file. */
  path: string;
  id: string;
  title: string;
  created: string;
  updated: string;
}

const TURN_MARKER = /^<!-- plato:turn (\{.*\}) -->$/;
const TURN_HEADINGS: Record<ChatTurn["role"], string> = { user: "### Question", assistant: "### Answer" };

export const chatFolder = (docPath: string) => `${CHATS_DIR}/${docPath}`;

export const newChatId = () => `chat-${crypto.randomUUID().slice(0, 8)}`;

/** ISO time with milliseconds, so "most recent" ordering never ties. */
export const nowIso = () => new Date().toISOString();

/** Title from the first question: one line, at most ~70 characters. */
export function titleFrom(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  if (line.length <= 70) return line || "Untitled chat";
  const cut = line.slice(0, 70);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 70)}…`;
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "chat";
}

/** `<date>-<slug>.md`, made unique among `existing` file names. */
export function chatFileName(chat: Chat, existing: string[]): string {
  const base = `${chat.created.slice(0, 10)}-${slugify(chat.title)}`;
  let name = `${base}.md`;
  for (let i = 2; existing.includes(name); i++) name = `${base}-${i}.md`;
  return name;
}

export function serializeChat(chat: Chat): string {
  const models = [...new Set(chat.turns.flatMap((t) => (t.model ? [t.model] : [])))];
  const front: [string, unknown][] = [
    ["type", "chat"],
    ["id", chat.id],
    ["title", chat.title],
    ["source", chat.source],
    ["created", chat.created],
    ["updated", chat.updated],
    ["models", models],
  ];
  const lines = ["---", ...front.map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""];
  lines.push(`# ${chat.title.replace(/\n/g, " ")}`, "", `Chat about [[${chat.source}]].`, "");
  for (const turn of chat.turns) {
    const meta: Record<string, string | number> = { role: turn.role, at: turn.at };
    if (turn.model) meta.model = turn.model;
    if (turn.passage) {
      meta.highlight = turn.passage.highlight;
      meta.page = turn.passage.page;
    }
    lines.push(`<!-- plato:turn ${JSON.stringify(meta)} -->`, TURN_HEADINGS[turn.role], "");
    if (turn.passage) lines.push(...passageBlock(turn.passage, chat.source), "");
    lines.push(turn.content.trim(), "");
  }
  return lines.join("\n");
}

const basename = (path: string) => path.split("/").pop() ?? path;

/** The quote as a blockquote, cited with an Obsidian-style page link. */
function passageBlock(p: Passage, source: string): string[] {
  const quoted = p.quote.split("\n").map((l) => `> ${l}`.trimEnd());
  return [...quoted, ">", `> — [[${source}#page=${p.page}|${basename(source)}, p. ${p.page}]]`];
}

const CITATION = /^— \[\[.*\]\]$/;

/** Split a user turn body into its leading passage blockquote and the question. */
function splitPassage(content: string): { quote: string; rest: string } {
  const lines = content.split("\n");
  let i = 0;
  const quoted: string[] = [];
  while (i < lines.length && lines[i].startsWith(">")) {
    quoted.push(lines[i].replace(/^> ?/, ""));
    i++;
  }
  while (quoted.length && (quoted[quoted.length - 1].trim() === "" || CITATION.test(quoted[quoted.length - 1].trim()))) {
    quoted.pop();
  }
  return { quote: quoted.join("\n").trim(), rest: lines.slice(i).join("\n").trim() };
}

/** Parse a chat file. Tolerates hand edits: unknown front matter keys,
 *  missing headings, and text outside turns (which is ignored). */
export function parseChat(text: string): Chat {
  const normalized = text.replace(/\r\n/g, "\n");
  const front: Record<string, unknown> = {};
  let body = normalized;
  const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = normalized.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const raw = line.slice(i + 1).trim();
      try {
        front[key] = JSON.parse(raw);
      } catch {
        front[key] = raw.replace(/^["']|["']$/g, ""); // plain YAML scalar from a hand edit
      }
    }
  }

  const turns: ChatTurn[] = [];
  let current: { meta: Record<string, unknown>; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const lines = [...current.lines];
    while (lines.length && !lines[0].trim()) lines.shift();
    const role = current.meta.role === "assistant" ? "assistant" : "user";
    if (lines[0]?.trim() === TURN_HEADINGS[role]) lines.shift();
    let content = lines.join("\n").trim();
    let passage: Passage | undefined;
    // Only turns whose marker names a highlight carry a passage; a blockquote
    // the user typed into a question stays part of the question.
    if (role === "user" && typeof current.meta.highlight === "string") {
      const { quote, rest } = splitPassage(content);
      passage = { highlight: current.meta.highlight, page: Number(current.meta.page) || 0, quote };
      content = rest;
    }
    const turn: ChatTurn = { role, content, at: String(current.meta.at ?? "") };
    if (passage) turn.passage = passage;
    if (typeof current.meta.model === "string") turn.model = current.meta.model;
    turns.push(turn);
  };
  for (const line of body.split("\n")) {
    const m = line.match(TURN_MARKER);
    if (m) {
      finish();
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(m[1]);
      } catch {}
      current = { meta, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  finish();

  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    id: str(front.id, newChatId()),
    title: str(front.title, "Untitled chat"),
    source: str(front.source, ""),
    created: str(front.created, ""),
    updated: str(front.updated, ""),
    turns,
  };
}

/** Saved chats for a document, most recently updated first. */
export async function listChats(docPath: string): Promise<ChatSummary[]> {
  const folder = chatFolder(docPath);
  const entries = await listDir(folder);
  const files = entries.filter((e) => !e.is_dir && e.name.endsWith(".md"));
  const summaries = await Promise.all(
    files.map(async (f) => {
      const path = `${folder}/${f.name}`;
      try {
        const chat = parseChat(await readTextFile(path));
        return { path, id: chat.id, title: chat.title, created: chat.created, updated: chat.updated };
      } catch {
        return null; // unreadable file: skip it rather than break the list
      }
    }),
  );
  return summaries
    .filter((s): s is ChatSummary => s !== null)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function loadChat(path: string): Promise<Chat | null> {
  const text = await readTextFileOpt(path);
  return text === null ? null : parseChat(text);
}

/** Write a chat; a new chat (no `path`) gets a fresh file name. Returns its path. */
export async function saveChat(chat: Chat, path: string | null): Promise<string> {
  let target = path;
  if (!target) {
    const folder = chatFolder(chat.source);
    const existing = (await listDir(folder)).map((e) => e.name);
    target = `${folder}/${chatFileName(chat, existing)}`;
  }
  await writeTextFile(target, serializeChat(chat));
  return target;
}

export const deleteChat = (path: string) => deleteAppFile(path);

/** The most recent saved chat of a document that discusses a highlight. */
export async function findChatForHighlight(docPath: string, highlightId: string): Promise<string | null> {
  for (const summary of await listChats(docPath)) {
    const chat = await loadChat(summary.path).catch(() => null);
    if (chat?.turns.some((t) => t.passage?.highlight === highlightId)) return summary.path;
  }
  return null;
}
