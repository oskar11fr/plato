// Sign in with ChatGPT UI pieces, following OpenAI's SIWC UI guidelines:
// a "Continue with ChatGPT" button with the ChatGPT logo, and a one-time
// notice the first time the app uses the user's ChatGPT plan.
import { useState } from "react";
import logo from "../assets/chatgpt-logo-white.svg";
import {
  ackWelcome,
  cancelSignIn,
  openManageUsage,
  signIn,
  toLlmError,
  type AccountInfo,
  type SignInMode,
} from "../lib/llm";

export function useSignIn(onSignedIn: (info: AccountInfo) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(mode: SignInMode = "continue") {
    setPending(true);
    setError(null);
    try {
      onSignedIn(await signIn(mode));
    } catch (e) {
      const err = toLlmError(e);
      if (err.kind !== "cancelled") setError(err.message);
    } finally {
      setPending(false);
    }
  }

  return { pending, error, start, cancel: () => void cancelSignIn() };
}

export function ContinueWithChatGPT({
  pending,
  onClick,
  onCancel,
  label = "Continue with ChatGPT",
}: {
  pending: boolean;
  onClick: () => void;
  onCancel: () => void;
  label?: string;
}) {
  if (pending) {
    return (
      <div className="siwc-pending">
        <span className="muted">Finish signing in in your browser…</span>
        <button onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  return (
    <button className="siwc-button" onClick={onClick}>
      <img src={logo} alt="" width={18} height={18} />
      {label}
    </button>
  );
}

/** Shown once, after the first sign-in that enables plan usage. */
export function PlanWelcome({ onClose }: { onClose: () => void }) {
  async function close() {
    await ackWelcome().catch(() => {});
    onClose();
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="siwc-welcome-title">
      <div className="modal">
        <h3 id="siwc-welcome-title">You're using your ChatGPT plan</h3>
        <p>
          Eligible usage in this app uses your ChatGPT plan. Manage usage in your{" "}
          <button className="link-button" onClick={() => void openManageUsage()}>
            ChatGPT settings
          </button>
          .
        </p>
        <div className="modal-actions">
          <button onClick={close} autoFocus>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
