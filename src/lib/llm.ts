// Typed wrappers over the Rust LLM commands. Keys never reach this side:
// the backend reads them from the OS keychain.
import { Channel, invoke } from "@tauri-apps/api/core";

export type ProviderId = "anthropic";
export const DEFAULT_PROVIDER: ProviderId = "anthropic";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** Omit to use the provider's default model. */
  model?: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type StreamEvent =
  | { type: "started"; model: string }
  | { type: "textDelta"; text: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "finished"; stopReason: string | null; usage: Usage };

export interface LlmError {
  /** "missing_key", "authentication_error", "rate_limit_error", "cancelled", ... */
  kind: string;
  message: string;
}

export interface AskHandle {
  /** Resolves when the reply is complete; rejects with an LlmError. */
  done: Promise<void>;
  cancel: () => void;
}

export function ask(
  request: ChatRequest,
  onEvent: (event: StreamEvent) => void,
  provider: ProviderId = DEFAULT_PROVIDER,
): AskHandle {
  const requestId = crypto.randomUUID();
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  const done = invoke<void>("llm_ask", { provider, requestId, request, onEvent: channel }).catch(
    (e: unknown) => {
      throw toLlmError(e);
    },
  );
  return { done, cancel: () => void invoke("llm_cancel", { requestId }) };
}

export function toLlmError(e: unknown): LlmError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as LlmError;
  return { kind: "unknown", message: String(e) };
}

export const hasApiKey = (provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<boolean>("has_api_key", { provider });

export const setApiKey = (key: string, provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<void>("set_api_key", { provider, key });

export const deleteApiKey = (provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<void>("delete_api_key", { provider });

export const defaultModel = (provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<string>("llm_default_model", { provider });
