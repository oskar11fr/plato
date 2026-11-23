import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ask, hasApiKey, setApiKey, toLlmError, type AskHandle, type ChatMessage, type LlmError } from "../lib/llm";
import type { ChatParams } from "./open";

/** A turn as shown in the pane; `model` is the model that actually answered. */
interface Turn extends ChatMessage {
  model?: string;
  note?: string;
  error?: LlmError;
}

const systemPrompt = (docPath: string) =>
  `You are a reading assistant in a research reader app. The user is reading "${docPath}" and asks questions about it. Answer clearly and concisely. When you rely on the text, quote the exact passage.`;

// In-memory for now: the chat file format (.reader/chats/<doc>.md) and
// Ask AI from a highlight come next.
export function ChatPane({ params }: IDockviewPanelProps<ChatParams>) {
  const [keyState, setKeyState] = useState<"checking" | "missing" | "ready">("checking");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState<AskHandle | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hasApiKey().then(
      (has) => setKeyState(has ? "ready" : "missing"),
      () => setKeyState("missing"),
    );
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  useEffect(() => () => running?.cancel(), [running]);

  function updateLast(update: (t: Turn) => Turn) {
    setTurns((ts) => [...ts.slice(0, -1), update(ts[ts.length - 1])]);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || running) return;
    setInput("");

    // Only question/answer pairs whose answer succeeded go back to the model.
    const history: ChatMessage[] = [];
    turns.forEach((t, i) => {
      const q = turns[i - 1];
      if (t.role === "assistant" && !t.error && t.content && q?.role === "user") {
        history.push({ role: "user", content: q.content }, { role: "assistant", content: t.content });
      }
    });
    const messages: ChatMessage[] = [...history, { role: "user", content: question }];
    setTurns((ts) => [...ts, { role: "user", content: question }, { role: "assistant", content: "" }]);

    const handle = ask({ system: systemPrompt(params.docPath), messages }, (event) => {
      switch (event.type) {
        case "started":
          updateLast((t) => ({ ...t, model: event.model }));
          break;
        case "textDelta":
          updateLast((t) => ({ ...t, content: t.content + event.text }));
          break;
        case "fallback":
          updateLast((t) => ({ ...t, model: event.to, note: `${event.from} declined; ${event.to} continued` }));
          break;
        case "finished":
          if (event.stopReason === "refusal") {
            updateLast((t) => ({ ...t, error: { kind: "refusal", message: "The model declined to answer." } }));
          } else if (event.stopReason === "max_tokens") {
            updateLast((t) => ({ ...t, note: "Reply cut off at the length limit." }));
          }
          break;
      }
    });
    setRunning(handle);
    try {
      await handle.done;
    } catch (err) {
      const error = toLlmError(err);
      updateLast((t) => ({ ...t, error }));
      if (error.kind === "missing_key" || error.kind === "authentication_error") setKeyState("missing");
    } finally {
      setRunning(null);
    }
  }

  if (keyState === "checking") return <div className="pane pane-message muted">Checking API key…</div>;
  if (keyState === "missing") return <ApiKeyForm onSaved={() => setKeyState("ready")} />;

  return (
    <div className="chat-pane">
      <div className="chat-log">
        {turns.length === 0 && (
          <p className="muted chat-empty">
            Ask about <strong>{params.docPath}</strong>.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.role === "assistant" && t.model && <div className="chat-meta">{t.model}</div>}
            <div className="chat-text">
              {t.content || (running && i === turns.length - 1 && !t.error ? "…" : "")}
            </div>
            {t.note && <div className="chat-note">{t.note}</div>}
            {t.error && t.error.kind !== "cancelled" && <div className="chat-error">{t.error.message}</div>}
            {t.error?.kind === "cancelled" && <div className="chat-note">Stopped.</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form className="chat-input" onSubmit={send}>
        <textarea
          value={input}
          placeholder="Ask a question…"
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
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function ApiKeyForm({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await setApiKey(key);
      setKey("");
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form className="pane pane-message api-key-form" onSubmit={save}>
      <p>
        <strong>Anthropic API key</strong>
      </p>
      <p className="muted">Stored in your system keychain. It never leaves this computer except to call the API.</p>
      <input
        type="password"
        value={key}
        placeholder="sk-ant-…"
        autoComplete="off"
        onChange={(e) => setKey(e.target.value)}
      />
      <button type="submit" disabled={!key.trim()}>
        Save key
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
