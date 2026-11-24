import { useEffect, useState } from "react";
import { ContinueWithChatGPT, PlanWelcome, useSignIn } from "../components/ChatGptSignIn";
import { account, listModels, openManageUsage, signOut, toLlmError, type AccountInfo } from "../lib/llm";

export function SettingsPane() {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    account().then(
      (a) => {
        setInfo(a);
        setWelcome(a.showWelcome);
      },
      (e) => setNotice({ ok: false, text: toLlmError(e).message }),
    );
  }
  useEffect(refresh, []);

  const signIn = useSignIn(() => {
    setNotice(null);
    refresh();
  });

  async function doSignOut() {
    setBusy(true);
    try {
      const confirmed = await signOut();
      setNotice(
        confirmed
          ? { ok: true, text: "Signed out." }
          : {
              ok: false,
              text: "Signed out on this computer, but OpenAI didn't confirm ending the session. You can disconnect Plato in ChatGPT settings.",
            },
      );
    } catch (e) {
      setNotice({ ok: false, text: toLlmError(e).message });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function testConnection() {
    setBusy(true);
    setNotice(null);
    try {
      const models = await listModels();
      setNotice({ ok: true, text: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.` });
    } catch (e) {
      setNotice({ ok: false, text: toLlmError(e).message });
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <div className="pane pane-message">{notice?.text ?? "Loading…"}</div>;

  return (
    <div className="pane settings-pane">
      {welcome && <PlanWelcome onClose={() => setWelcome(false)} />}
      <h2>ChatGPT account</h2>

      {info.signedIn ? (
        <section>
          <p>
            Signed in as <strong>{info.email ?? "your ChatGPT account"}</strong>
          </p>
          <div className="plan-option">
            <div>
              <strong>Use your ChatGPT plan</strong>
              <p className="muted">
                Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.
                Plato has no subscription or charges of its own.
              </p>
            </div>
            <span className={info.planEnabled ? "ok" : "error"}>{info.planEnabled ? "On" : "Off"}</span>
          </div>
          {!info.planEnabled && (
            <ContinueWithChatGPT
              pending={signIn.pending}
              onClick={() => signIn.start("enablePlan")}
              onCancel={signIn.cancel}
              label="Allow in ChatGPT"
            />
          )}
          <div className="row actions">
            <button onClick={() => void openManageUsage()}>Manage usage</button>
            <button onClick={testConnection} disabled={busy || !info.planEnabled}>
              Test connection
            </button>
            <button onClick={doSignOut} disabled={busy}>
              Sign out
            </button>
          </div>
          <p>
            <button className="link-button" onClick={() => signIn.start("newAccount")} disabled={signIn.pending}>
              Use a different ChatGPT account…
            </button>
          </p>
        </section>
      ) : (
        <section>
          <p className="muted">
            Sign in with your ChatGPT account to ask questions. Eligible usage uses your ChatGPT plan; no API key is
            needed.
          </p>
          <ContinueWithChatGPT pending={signIn.pending} onClick={() => signIn.start("continue")} onCancel={signIn.cancel} />
          {info.hasRegistration && (
            <p>
              <button className="link-button" onClick={() => signIn.start("newAccount")} disabled={signIn.pending}>
                Use a different ChatGPT account…
              </button>
            </p>
          )}
        </section>
      )}

      {signIn.error && <p className="error">{signIn.error}</p>}
      {notice && <p className={notice.ok ? "ok" : "error"}>{notice.text}</p>}
    </div>
  );
}
