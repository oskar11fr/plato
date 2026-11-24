// Typed wrappers over the Rust LLM commands. Credentials never reach this
// side: the backend holds the ChatGPT tokens and refreshes them.
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export type ProviderId = "openai";
export const DEFAULT_PROVIDER: ProviderId = "openai";

export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
export const openManageUsage = () => openUrl(MANAGE_USAGE_URL);

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** Omit to use the account's default model. */
  model?: string;
  system: string;
  messages: ChatMessage[];
  effort?: "low" | "medium" | "high";
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
  | { type: "finished"; stopReason: string | null; usage: Usage };

export interface LlmError {
  /** "signin_required", "plan_not_enabled", "subscription_sharing_usage_limit_exceeded", "cancelled", ... */
  kind: string;
  message: string;
}

export const USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded";
/** Errors that mean the account needs attention before asking again. */
export const SIGN_IN_ERRORS = new Set([
  "signin_required",
  "plan_not_enabled",
  "subscription_sharing_invalid_user",
  "invalid_client",
]);

export interface AskHandle {
  /** Resolves when the reply is complete; rejects with an LlmError. */
  done: Promise<void>;
  cancel: () => void;
}

export function toLlmError(e: unknown): LlmError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as LlmError;
  return { kind: "unknown", message: String(e) };
}

const rethrow = (e: unknown): never => {
  throw toLlmError(e);
};

export function ask(
  request: ChatRequest,
  onEvent: (event: StreamEvent) => void,
  provider: ProviderId = DEFAULT_PROVIDER,
): AskHandle {
  const requestId = crypto.randomUUID();
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  const done = invoke<void>("llm_ask", { provider, requestId, request, onEvent: channel }).catch(rethrow);
  return { done, cancel: () => void invoke("llm_cancel", { requestId }) };
}

export interface AuthStatus {
  ready: boolean;
  mode: string;
  kind: string | null;
  message: string | null;
  account: string | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

export const authStatus = (provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<AuthStatus>("llm_auth_status", { provider }).catch(rethrow);

export const listModels = (provider: ProviderId = DEFAULT_PROVIDER) =>
  invoke<ModelInfo[]>("llm_list_models", { provider }).catch(rethrow);

// ---- Sign in with ChatGPT ---------------------------------------------------

export interface AccountInfo {
  signedIn: boolean;
  email: string | null;
  planEnabled: boolean;
  /** Show the one-time "You're using your ChatGPT plan" notice. */
  showWelcome: boolean;
  hasRegistration: boolean;
}

/** "continue": saved account (or register); "newAccount": another account; "enablePlan": re-consent. */
export type SignInMode = "continue" | "newAccount" | "enablePlan";

/** Opens the browser; resolves once signed in. */
export const signIn = (mode: SignInMode = "continue") =>
  invoke<AccountInfo>("chatgpt_sign_in", { mode }).catch(rethrow);

export const cancelSignIn = () => invoke<void>("chatgpt_cancel_sign_in");

/** Resolves to whether OpenAI confirmed revoking the session. */
export const signOut = () => invoke<boolean>("chatgpt_sign_out").catch(rethrow);

export const account = () => invoke<AccountInfo>("chatgpt_account").catch(rethrow);

export const ackWelcome = () => invoke<void>("chatgpt_ack_welcome").catch(rethrow);
