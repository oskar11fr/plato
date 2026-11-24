# Plato

A desktop research reader: open a folder of PDFs and notes, read and highlight
in side-by-side panes, and ask an AI about any passage. Everything is stored as
plain files inside the folder (`.reader/` holds annotations, chats and layout).

Built with Tauri 2 (Rust backend), React + TypeScript, dockview and pdf.js.
Answers come from OpenAI models via Sign in with ChatGPT.

## Develop

Requires Node and Rust (`rustup`).

```sh
npm install
npm run tauri dev     # run the app
npm test              # frontend unit tests
cd src-tauri && cargo test   # backend tests
```

## Signing in (ChatGPT)

Plato uses OpenAI's **Sign in with ChatGPT** flow for open-source apps
(https://developers.openai.com/siwc/token-sharing-open-source): click
**Continue with ChatGPT**, approve in the browser, and questions are answered
through the Responses API using your ChatGPT plan. No API key is needed.

- The first sign-in registers Plato with your account; later sign-ins reuse
  that registration. Manage or disconnect it at ChatGPT Settings → Usage.
- Tokens are stored in `chatgpt-accounts.json` in the app config folder
  (owner-only permissions), refreshed automatically, and revoked on sign-out.
- ChatGPT plan usage through third-party apps is a preview; Plus plans share a
  five-hour usage limit across all such apps.

## Managing files

- **+ Add files** (bottom of the sidebar) copies files from your computer into
  the selected folder; click a folder to select it, opening a file selects its
  folder. Dropping files from Finder onto a folder in the sidebar does the same.
- **Drag a file onto a folder** in the sidebar to move it (onto empty space:
  the workspace root). Its highlights and chats move with it, and the chats'
  `source` and `[[links]]` are updated.
- **Right-click a file** for *Show in Finder* and *Move to Trash…*. Trashed
  files can be restored from the Trash; their highlights and chats are kept.
- Nothing is ever overwritten: a taken name gets a ` (2)` suffix.

## Chats

Each document can have several chats; each is a Markdown file:

```
.reader/chats/<document path>/<YYYY-MM-DD>-<title-slug>.md
```

with YAML front matter (`type`, `id`, `title`, `source`, `created`, `updated`,
`models`), a `[[document]]` wikilink, and the turns in order. Every turn starts
with a `<!-- plato:turn {...} -->` comment carrying its role, time and model, so
the files read naturally and can be parsed back (e.g. to build a wiki).
A chat is saved after each completed answer; **New chat** starts fresh context.

**Ask AI** on a PDF selection attaches the passage to the document's open
chat. The model gets the quote, the full text of its page, and the question;
the saved turn keeps the quote as a blockquote cited with
`[[paper.pdf#page=N|…]]` and the highlight id in its marker. Clicking the
quote jumps to the highlight; clicking a highlight offers **Show in chat**.

## Wiki summaries

**Summarize** in a PDF's toolbar opens a summary pane. The model reads the
whole document (with an optional focus and the passages you highlighted) and
writes a wiki page. Ask for changes, or **Edit** the text by hand; every
version is kept (◀ ▶), and **Show changes** marks what a revision changed.
Nothing reaches the wiki until **Save to wiki**:

```
wiki/index.md                 list of source pages (rewritten on each save)
wiki/sources/<title-slug>.md  one page per document
```

A page has front matter (`type`, `title`, `authors`, `year`,
`source: "[[paper.pdf]]"`, `created`, `updated`, `model`), cites pages as
`[[paper.pdf#page=N|p. N]]`, and links concepts as `[[concept]]` (meant for
`wiki/concepts/`, which wiki generation will fill). Links open in the app:
a page citation scrolls the PDF to that page. Drafts live in
`.reader/drafts/<document>/summary.json` until discarded; moving a PDF moves
its draft and updates links to it throughout `wiki/`.

What a summary should contain is a *skill*: `src/skills/summarize-source/SKILL.md`
(Agent Skills layout: `name` and `description` front matter, then the
instructions). Settings → **Summary instructions** edits it per workspace
(saved to `.reader/skills/summarize-source/SKILL.md`). The page format the app
parses is fixed in `src/lib/summary.ts`, so custom instructions can't break it.

## Layout

- `src-tauri/src/workspace.rs` – all file access, scoped to the open folder
- `src-tauri/src/llm/` – `Provider` trait; `openai/` holds the Responses API
  provider and `openai/auth.rs` the Sign in with ChatGPT flow
- `src/pdf/` – pdf.js viewer, highlight anchoring (quote + prefix/suffix + rects)
- `src/lib/chats.ts` – chat file format, listing, saving
- `src/lib/summary.ts`, `src/lib/wiki.ts` – summary prompts, drafts, wiki pages and index
- `src/skills/` – built-in skills (instructions for AI tasks)
- `src/panes/` – dockview pane types (PDF, text, chat, summary, settings)
