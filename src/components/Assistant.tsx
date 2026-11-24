// What every AI pane needs: the sign-in state, the account's models and the
// chosen one, and what to show when the account needs attention.
import { useEffect, useState } from "react";
import { account, authStatus, listModels, openManageUsage, toLlmError, type AuthStatus, type ModelInfo } from "../lib/llm";
import { ContinueWithChatGPT, useSignIn } from "./ChatGptSignIn";

const MODEL_KEY = "plato.model";
function savedModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}
function saveModel(id: string) {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {}
}

export function useAssistant() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModelState] = useState<string | null>(null);

  function checkAuth() {
    authStatus().then(setAuth, (e) =>
      setAuth({ ready: false, mode: "chatgpt", kind: "unknown", message: toLlmError(e).message, account: null }),
    );
    account().then((a) => setWelcome(a.showWelcome), () => {});
  }

  useEffect(checkAuth, []);

  // The model picker lists the signed-in account's models; the choice is
  // shared by all panes.
  useEffect(() => {
    if (!auth?.ready) return;
    listModels().then(
      (list) => {
        setModels(list);
        const saved = savedModel();
        setModelState(list.some((m) => m.id === saved) ? saved : (list[0]?.id ?? null));
      },
      () => setModels([]),
    );
  }, [auth?.ready, auth?.account]);

  function setModel(id: string) {
    setModelState(id);
    saveModel(id);
  }

  return { auth, checkAuth, welcome, closeWelcome: () => setWelcome(false), models, model, setModel };
}

export function ModelPicker({ models, model, onChange }: { models: ModelInfo[]; model: string | null; onChange: (id: string) => void }) {
  if (models.length === 0) return null;
  return (
    <select value={model ?? ""} aria-label="Model" onChange={(e) => onChange(e.target.value)}>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}

export function UsageFooter() {
  return (
    <>
      <span className="muted">Using ChatGPT plan</span>
      <button className="link-button" onClick={() => void openManageUsage()}>
        Manage usage
      </button>
    </>
  );
}

export function SignInNotice({
  status,
  onSignedIn,
  onOpenSettings,
  purpose = "ask questions",
}: {
  status: AuthStatus;
  onSignedIn: () => void;
  onOpenSettings: () => void;
  /** e.g. "ask questions", "write summaries" */
  purpose?: string;
}) {
  const signIn = useSignIn(onSignedIn);
  const planOff = status.kind === "plan_not_enabled";

  return (
    <div className="pane pane-message connection-notice">
      {planOff ? (
        <>
          <p>
            <strong>Use your ChatGPT plan</strong>
          </p>
          <p className="muted">
            You're signed in{status.account ? ` as ${status.account}` : ""}, but Plato isn't allowed to use your
            ChatGPT plan yet. Complete eligible AI requests in this app with usage included in your ChatGPT plan.
          </p>
          <ContinueWithChatGPT
            pending={signIn.pending}
            onClick={() => signIn.start("enablePlan")}
            onCancel={signIn.cancel}
            label="Allow in ChatGPT"
          />
        </>
      ) : status.kind === "signin_required" ? (
        <>
          <p>
            <strong>Sign in to {purpose}</strong>
          </p>
          <p className="muted">Answers use your ChatGPT plan. No API key needed.</p>
          <ContinueWithChatGPT pending={signIn.pending} onClick={() => signIn.start("continue")} onCancel={signIn.cancel} />
        </>
      ) : (
        <>
          <p>
            <strong>Not connected</strong>
          </p>
          <p className="muted">{status.message}</p>
          <button onClick={onSignedIn}>Check again</button>
        </>
      )}
      {signIn.error && <p className="error">{signIn.error}</p>}
      <p>
        <button className="link-button" onClick={onOpenSettings}>
          Account settings…
        </button>
      </p>
    </div>
  );
}
