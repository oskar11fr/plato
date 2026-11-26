import { useEffect, useState } from "react";
import { ContinueWithChatGPT, PlanWelcome, useSignIn } from "../components/ChatGptSignIn";
import { account, listModels, openManageUsage, signOut, toLlmError, type AccountInfo } from "../lib/llm";
import { setThemePref, themePref, type ThemePref } from "../lib/theme";
import { builtInSkill, loadSkill, resetSkill, saveSkillOverride, skillOverridePath, type Skill, type SkillName } from "../lib/skills";

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
      <Appearance />
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

      <SkillEditor name="summarize-source" />
      <SkillEditor name="summarize-section" />
    </div>
  );
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Paper (light)" },
  { value: "dark", label: "Night study (dark)" },
];

function Appearance() {
  const [pref, setPref] = useState<ThemePref>(themePref);
  return (
    <section className="appearance">
      <h2>Appearance</h2>
      <fieldset>
        <legend className="visually-hidden">Theme</legend>
        {THEMES.map((t) => (
          <label key={t.value} className="radio">
            <input
              type="radio"
              name="theme"
              value={t.value}
              checked={pref === t.value}
              onChange={() => {
                setPref(t.value);
                setThemePref(t.value);
              }}
            />
            {t.label}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

const SKILL_TEXT: Record<SkillName, { heading: string; about: string }> = {
  "summarize-source": {
    heading: "Summary instructions",
    about: "What the AI is told about writing a summary page: its sections, length and style.",
  },
  "summarize-section": {
    heading: "Chapter instructions",
    about: "What the AI is told when it summarizes a book chapter by chapter: each chapter page's sections, length and style.",
  },
};

/** Edit a skill's instructions for this workspace (saved in .reader/skills/). */
function SkillEditor({ name }: { name: SkillName }) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function load() {
    loadSkill(name).then(
      (s) => {
        setSkill(s);
        setText(s.text);
      },
      (e) => setMessage({ ok: false, text: String(e) }),
    );
  }
  useEffect(load, [name]);

  if (!skill) return null;
  const changed = text !== skill.text;

  async function save() {
    try {
      if (text.trim() === builtInSkill(name).text.trim()) await resetSkill(name);
      else await saveSkillOverride(name, text);
      setMessage({ ok: true, text: "Saved. New summaries use these instructions." });
      load();
    } catch (e) {
      setMessage({ ok: false, text: `Not saved: ${String(e)}` });
    }
  }

  async function reset() {
    try {
      await resetSkill(name);
      setMessage({ ok: true, text: "Back to the built-in instructions." });
      load();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    }
  }

  return (
    <section className="skill-editor">
      <h2>{SKILL_TEXT[name].heading}</h2>
      <p className="muted">
        {SKILL_TEXT[name].about} Changes apply to this
        workspace{skill.origin === "workspace" ? (
          <>
            {" "}
            and are saved in <code>{skillOverridePath(name)}</code>
          </>
        ) : null}
        . The page format (front matter, page citations, [[links]]) is fixed by the app.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck rows={18} aria-label={SKILL_TEXT[name].heading} />
      <div className="row actions">
        <button onClick={() => void save()} disabled={!changed}>
          Save
        </button>
        <button onClick={() => setText(skill.text)} disabled={!changed}>
          Undo changes
        </button>
        <button onClick={() => void reset()} disabled={skill.origin === "built-in"}>
          Use built-in instructions
        </button>
        <span className="muted">{skill.origin === "workspace" ? "Customized" : "Built-in"}</span>
      </div>
      {message && <p className={message.ok ? "ok" : "error"}>{message.text}</p>}
    </section>
  );
}
