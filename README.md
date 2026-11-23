# Plato

A desktop research reader: open a folder of PDFs and notes, read and highlight
in side-by-side panes, and ask an AI about any passage. Everything is stored as
plain files inside the folder (`.reader/` holds annotations, chats and layout).

Built with Tauri 2 (Rust backend), React + TypeScript, dockview and pdf.js.

## Develop

Requires Node and Rust (`rustup`).

```sh
npm install
npm run tauri dev     # run the app
npm test              # frontend unit tests
cd src-tauri && cargo test   # backend tests
```

The Anthropic API key is stored in the OS keychain (entered in the chat pane).
During development `ANTHROPIC_API_KEY` is used as a fallback.

## Layout

- `src-tauri/src/workspace.rs` – all file access, scoped to the open folder
- `src-tauri/src/llm/` – `Provider` trait and the Anthropic adapter (streaming)
- `src-tauri/src/secrets.rs` – API keys in the OS keychain
- `src/pdf/` – pdf.js viewer, highlight anchoring (quote + prefix/suffix + rects)
- `src/panes/` – dockview pane types (PDF, text, chat)
