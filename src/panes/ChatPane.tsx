import { ask as confirmDialog } from "@tauri-apps/plugin-dialog";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ModelPicker, SignInNotice, UsageFooter, useAssistant } from "../components/Assistant";
import { PlanWelcome } from "../components/ChatGptSignIn";
import { Markdown } from "../components/Markdown";
import { passageToChat, revealHighlight, showChat, type PassageAttachment } from "../lib/bus";
import {
  deleteChat,
  listChats,
  loadChat,
  newChatId,
  nowIso,
  saveChat,
  titleFrom,
  type Chat,
  type ChatSummary,
  type Passage,
} from "../lib/chats";
import {
  ask,
  openManageUsage,
  SIGN_IN_ERRORS,
  toLlmError,
  USAGE_LIMIT,
  type AskHandle,
  type ChatMessage,
  type LlmError,
} from "../lib/llm";
import { DEFAULT_PASSAGE_QUESTION, systemPrompt, userMessage } from "../lib/prompt";
import { openFile, openSettings, openWikiLink, type ChatParams } from "./open";

/** A turn as shown in the pane; `model` is the model that actually answered. */
interface Turn extends ChatMessage {
  /** For a question about a selected passage. */
  passage?: Passage;
  model?: string;
  note?: string;
  error?: LlmError;
}

const emptyChat = (docPath: string): Chat => {
  const t = nowIso();
  return { id: newChatId(), title: "New chat", source: docPath, created: t, updated: t, turns: [] };
};

const toTurns = (chat: Chat): Turn[] =>
  chat.turns.map(({ role, content, model, passage }) => ({ role, content, model, ...(passage ? { passage } : {}) }));

/** One pane per document. It shows one chat at a time; each chat is saved to
 *  .reader/chats/<document>/ after every completed answer. */
export function ChatPane({ params, api, containerApi }: IDockviewPanelProps<ChatParams>) {
  const { auth, checkAuth, welcome, closeWelcome, models, model, setModel } = useAssistant();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState<AskHandle | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // The chat being shown, and its file (null until the first answer is saved).
  const current = useRef<{ chat: Chat; path: string | null }>({ chat: emptyChat(params.docPath), path: null });
  const [chatPath, setChatPath] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A passage from Ask AI, sent with the next question.
  const [attachment, setAttachment] = useState<PassageAttachment | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function show(chat: Chat, path: string | null) {
    current.current = { chat, path };
    setChatPath(path);
    setTurns(toTurns(chat));
    setSaveError(null);
    setLimitReached(false);
    // Remembered in the layout, so the same chat reopens after a restart.
    api.updateParameters({ docPath: params.docPath, chatPath: path ?? undefined });
  }

  async function refreshList() {
    setChatList(await listChats(params.docPath).catch(() => []));
  }

  // Open the chat remembered in the layout, else the most recent one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await listChats(params.docPath).catch(() => []);
      const wanted = params.chatPath ?? list[0]?.path;
      const chat = wanted ? await loadChat(wanted).catch(() => null) : null;
      if (cancelled) return;
      setChatList(list);
      if (chat && wanted) show(chat, wanted);
      else show(emptyChat(params.docPath), null);
      setChatsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the document changes
  }, [params.docPath]);

  // Messages from the PDF pane: Ask AI attaches a passage; "Show in chat"
  // switches to a saved chat. Handlers go through a ref so they see current state.
  const handlers = useRef({ switchTo });
  handlers.current = { switchTo };
  useEffect(() => {
    const offPassage = passageToChat.subscribe(params.docPath, (p) => {
      setAttachment(p);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    const offShow = showChat.subscribe(params.docPath, (path) => void handlers.current.switchTo(path));
    return () => {
      offPassage();
      offShow();
    };
  }, [params.docPath]);

  const onWikiLink = useCallback((target: string) => openWikiLink(containerApi, target), [containerApi]);

  /** Show the passage in the PDF (opening it if needed). */
  function reveal(p: Passage) {
    openFile(containerApi, params.docPath);
    revealHighlight.emit(params.docPath, { highlightId: p.highlight, page: p.page });
  }

  function newChat() {
    running?.cancel();
    show(emptyChat(params.docPath), null);
  }

  async function switchTo(path: string) {
    if (path === current.current.path) return;
    running?.cancel();
    const chat = await loadChat(path).catch(() => null);
    if (chat) show(chat, path);
    else {
      setSaveError("That chat could not be opened.");
      void refreshList();
    }
  }

  async function removeChat() {
    const { path, chat } = current.current;
    if (!path) return;
    const ok = await confirmDialog(`Delete the chat "${chat.title}"? This cannot be undone.`, {
      title: "Delete chat",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }).catch(() => false);
    if (!ok) return;
    running?.cancel();
    try {
      await deleteChat(path);
    } catch (e) {
      setSaveError(`Could not delete: ${String(e)}`);
      return;
    }
    const list = await listChats(params.docPath).catch(() => []);
    setChatList(list);
    const next = list[0] ? await loadChat(list[0].path).catch(() => null) : null;
    if (next && list[0]) show(next, list[0].path);
    else show(emptyChat(params.docPath), null);
  }

  /** Append a completed question/answer pair to the chat and write its file. */
  async function persist(
    chatId: string,
    question: string,
    passage: Passage | undefined,
    askedAt: string,
    answer: string,
    model?: string,
  ) {
    const { chat, path } = current.current;
    if (chat.id !== chatId) return; // the user switched chats meanwhile
    const now = nowIso();
    const first = chat.turns.length === 0;
    const next: Chat = {
      ...chat,
      // A bare "explain this" makes a poor title; use the quote instead.
      title: first ? titleFrom(passage && question === DEFAULT_PASSAGE_QUESTION ? `“${passage.quote}”` : question) : chat.title,
      created: first ? askedAt : chat.created,
      updated: now,
      turns: [
        ...chat.turns,
        { role: "user", content: question, at: askedAt, ...(passage ? { passage } : {}) },
        { role: "assistant", content: answer, at: now, ...(model ? { model } : {}) },
      ],
    };
    current.current = { chat: next, path };
    try {
      const saved = await saveChat(next, path);
      if (current.current.chat.id !== chatId) return;
      current.current = { chat: next, path: saved };
      setChatPath(saved);
      setSaveError(null);
      api.updateParameters({ docPath: params.docPath, chatPath: saved });
      void refreshList();
    } catch (e) {
      setSaveError(`Not saved: ${String(e)}`);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  useEffect(() => () => running?.cancel(), [running]);

  function updateLast(update: (t: Turn) => Turn) {
    setTurns((ts) => [...ts.slice(0, -1), update(ts[ts.length - 1])]);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (running) return;
    const attached = attachment;
    const question = input.trim() || (attached ? DEFAULT_PASSAGE_QUESTION : "");
    if (!question) return;
    const passage: Passage | undefined = attached
      ? { highlight: attached.highlightId, page: attached.page, quote: attached.quote }
      : undefined;
    setInput("");
    setAttachment(null);
    setLimitReached(false);

    // Only question/answer pairs whose answer succeeded go back to the model.
    // Earlier passages are replayed as quotes; only the new one brings its page text.
    const history: ChatMessage[] = [];
    turns.forEach((t, i) => {
      const q = turns[i - 1];
      if (t.role === "assistant" && !t.error && t.content && q?.role === "user") {
        history.push({ role: "user", content: userMessage(q) }, { role: "assistant", content: t.content });
      }
    });
    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: userMessage({ content: question, passage }, attached?.pageText) },
    ];
    setTurns((ts) => [
      ...ts,
      { role: "user", content: question, ...(passage ? { passage } : {}) },
      { role: "assistant", content: "" },
    ]);

    const request = { model: model ?? undefined, system: systemPrompt(params.docPath), messages };
    const chatId = current.current.chat.id;
    const askedAt = nowIso();
    let answer = "";
    let answerModel: string | undefined;
    let refused = false;
    const handle = ask(request, (event) => {
      switch (event.type) {
        case "started":
          answerModel = event.model || undefined;
          updateLast((t) => ({ ...t, model: event.model }));
          break;
        case "textDelta":
          answer += event.text;
          updateLast((t) => ({ ...t, content: t.content + event.text }));
          break;
        case "finished":
          refused = event.stopReason === "refusal";
          if (event.stopReason === "refusal") {
            updateLast((t) => ({ ...t, error: { kind: "refusal", message: "The model declined to answer." } }));
          } else if (event.stopReason === "max_tokens") {
            updateLast((t) => ({ ...t, note: "Reply cut off at the length limit." }));
          } else if (event.stopReason && event.stopReason !== "end_turn") {
            updateLast((t) => ({ ...t, note: `Reply incomplete (${event.stopReason}).` }));
          }
          break;
      }
    });
    setRunning(handle);
    try {
      await handle.done;
      if (!refused && answer.trim()) await persist(chatId, question, passage, askedAt, answer, answerModel);
    } catch (err) {
      const error = toLlmError(err);
      updateLast((t) => ({ ...t, error }));
      if (error.kind === USAGE_LIMIT) setLimitReached(true);
      if (SIGN_IN_ERRORS.has(error.kind)) checkAuth();
    } finally {
      setRunning(null);
    }
  }

  if (!auth) return <div className="pane pane-message muted">Checking sign-in…</div>;
  if (!auth.ready) {
    return <SignInNotice status={auth} onSignedIn={checkAuth} onOpenSettings={() => openSettings(containerApi)} />;
  }

  return (
    <div className="chat-pane">
      {welcome && <PlanWelcome onClose={closeWelcome} />}
      <div className="chat-header">
        <select
          aria-label="Chats for this document"
          value={chatPath ?? ""}
          disabled={!chatsLoaded}
          onChange={(e) => (e.target.value ? void switchTo(e.target.value) : newChat())}
        >
          {chatPath === null && <option value="">New chat</option>}
          {chatList.map((c) => (
            <option key={c.path} value={c.path}>
              {c.title} · {c.updated.slice(0, 10)}
            </option>
          ))}
        </select>
        <button onClick={newChat} title="Start a new chat with fresh context" disabled={chatPath === null && turns.length === 0}>
          New chat
        </button>
        <button onClick={() => void removeChat()} title="Delete this chat" disabled={!chatPath}>
          Delete
        </button>
      </div>
      <div className="chat-log">
        {turns.length === 0 && (
          <p className="muted chat-empty">
            Ask about <strong>{params.docPath}</strong>.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.passage && <PassageQuote passage={t.passage} onReveal={() => reveal(t.passage!)} />}
            <div className="turn-row">
              <span className="turn-label" aria-hidden="true">
                {t.role === "user" ? "q." : "a."}
              </span>
              <div className="turn-body">
                {t.role === "assistant" && t.content ? (
                  <Markdown text={t.content} onWikiLink={onWikiLink} />
                ) : (
                  <div className="chat-text">
                    {t.content || (running && i === turns.length - 1 && !t.error ? "…" : "")}
                  </div>
                )}
                {t.role === "assistant" && t.model && <div className="chat-meta">{t.model}</div>}
                {t.note && <div className="chat-note">{t.note}</div>}
                {t.error && t.error.kind !== "cancelled" && <div className="chat-error">{t.error.message}</div>}
                {t.error?.kind === "cancelled" && <div className="chat-note">Stopped.</div>}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {saveError && <div className="chat-save-error">{saveError}</div>}
      {limitReached && (
        <div className="usage-limit">
          <strong>Usage limit reached</strong>
          <button onClick={() => void openManageUsage()}>Manage usage</button>
        </div>
      )}
      {attachment && (
        <div className="chat-attachment">
          <button
            className="chat-attachment-quote"
            title="Show this passage in the PDF"
            onClick={() => reveal({ highlight: attachment.highlightId, page: attachment.page, quote: attachment.quote })}
          >
            <span className="chat-attachment-label">Passage · p. {attachment.page}</span>
            <span className="chat-attachment-text">“{attachment.quote}”</span>
          </button>
          <button className="icon-button" aria-label="Remove passage" title="Remove passage" onClick={() => setAttachment(null)}>
            ×
          </button>
        </div>
      )}
      <form className="chat-input" onSubmit={send}>
        <textarea
          ref={inputRef}
          value={input}
          placeholder={attachment ? `Ask about this passage… (Enter: “${DEFAULT_PASSAGE_QUESTION}”)` : "Ask a question…"}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
          }}
        />
        {running ? (
          <button type="button" onClick={() => running.cancel()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() && !attachment}>
            Send
          </button>
        )}
      </form>
      <div className="chat-footer">
        <ModelPicker models={models} model={model} onChange={setModel} />
        <UsageFooter />
      </div>
    </div>
  );
}

/** The quoted passage a question is about; click to show it in the PDF. */
function PassageQuote({ passage, onReveal }: { passage: Passage; onReveal: () => void }) {
  return (
    <button className="chat-passage" onClick={onReveal} title="Show in the PDF">
      <span className="chat-passage-text">“{passage.quote}”</span>
      <span className="chat-passage-source">p. {passage.page}</span>
    </button>
  );
}
