//! Sign in with ChatGPT, following OpenAI's documented flow for open-source
//! apps (https://developers.openai.com/siwc/token-sharing-open-source):
//!
//! 1. A stable host id (`urn:uuid:…`) is created once per installation.
//! 2. OAuth authorization code + PKCE in the system browser, with a loopback
//!    callback on 127.0.0.1. First sign-in registers the app with
//!    `client_id=dynamic_agent_client`; the callback returns the issued
//!    client id, which is saved and reused for later sign-ins.
//! 3. The code is exchanged at the token endpoint; the ID token is verified
//!    (JWKS signature, issuer, audience = issued client id, expiry, nonce).
//! 4. Plan usage requires the `chatgpt.tokens.use.direct` scope.
//! 5. Credentials are kept in an owner-only (0600) file in the app config
//!    folder, refreshed near expiry (refresh tokens rotate), and revoked on
//!    sign-out.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::llm::{AuthStatus, LlmError};

const REGISTRATION_CLIENT_ID: &str = "dynamic_agent_client";
const APP_NAME: &str = "Plato";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const CALLBACK_PATH: &str = "/auth/callback";
const PREFERRED_PORT: u16 = 1455;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Refresh when the access token has less than this left.
const REFRESH_MARGIN_SECS: i64 = 300;
const UNUSABLE_REFRESH_CODES: &[&str] = &[
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

/// OpenAI endpoints (overridable in tests).
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    pub revoke: String,
    pub jwks: String,
    pub resource: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            issuer: "https://auth.openai.com".into(),
            authorize: "https://auth.openai.com/api/accounts/authorize".into(),
            token: "https://auth.openai.com/api/accounts/oauth/token".into(),
            revoke: "https://auth.openai.com/api/accounts/oauth/revoke".into(),
            jwks: "https://auth.openai.com/.well-known/jwks.json".into(),
            resource: "https://api.openai.com/v1".into(),
        }
    }
}

// ---- Stored state ---------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
struct AccountFile {
    /// Stable, opaque id for this installation (`ext_agent_host_id`).
    host_id: Option<String>,
    /// Issued client id of the active registration.
    active: Option<String>,
    registrations: Vec<Registration>,
    /// The one-time "You're using your ChatGPT plan" notice was shown.
    welcome_shown: bool,
}

/// One ChatGPT account + workspace authorization (one issued client id).
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Registration {
    client_id: String,
    subject: String,
    email: Option<String>,
    /// Retained for `id_token_hint`; cleared on sign-out.
    id_token: Option<String>,
    tokens: Option<TokenSet>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct TokenSet {
    access_token: String,
    refresh_token: Option<String>,
    scopes: Vec<String>,
    /// Unix seconds.
    expires_at: i64,
    saved_at: i64,
}

impl TokenSet {
    fn plan_enabled(&self) -> bool {
        self.scopes.iter().any(|s| s == PLAN_SCOPE)
    }
}

#[derive(Deserialize, Debug)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
}

/// What the web view sees about the account (no tokens).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub signed_in: bool,
    pub email: Option<String>,
    pub plan_enabled: bool,
    /// The one-time plan notice still needs to be shown.
    pub show_welcome: bool,
    /// A previous registration exists (so "Continue" reuses it).
    pub has_registration: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignInMode {
    /// Re-authorize the saved account, or register one if there is none.
    Continue,
    /// Register a different ChatGPT account or workspace.
    NewAccount,
    /// Ask again for permission to use the ChatGPT plan.
    EnablePlan,
}

// ---- The authenticator ----------------------------------------------------

pub type BrowserOpener = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub struct ChatGptAuth {
    http: reqwest::Client,
    endpoints: Endpoints,
    path: PathBuf,
    /// Also serializes refreshes, since refresh tokens rotate.
    file: tokio::sync::Mutex<AccountFile>,
    sign_in: std::sync::Mutex<Option<CancellationToken>>,
    open_browser: BrowserOpener,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn auth_err(kind: &'static str, message: impl Into<String>) -> LlmError {
    LlmError::Auth { kind, message: message.into() }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl ChatGptAuth {
    pub fn new(path: PathBuf, endpoints: Endpoints, open_browser: BrowserOpener) -> Self {
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AccountFile>(&raw).ok())
            .unwrap_or_default();
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            endpoints,
            path,
            file: tokio::sync::Mutex::new(file),
            sign_in: std::sync::Mutex::new(None),
            open_browser,
        }
    }

    /// Write the account file atomically with owner-only permissions.
    fn save(&self, file: &AccountFile) -> Result<(), LlmError> {
        let io = |e: std::io::Error| LlmError::Protocol(format!("Could not save ChatGPT credentials: {e}"));
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        let tmp = self.path.with_extension("tmp-write");
        {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp).map_err(io)?;
            f.write_all(serde_json::to_string_pretty(file).expect("serialize").as_bytes()).map_err(io)?;
            f.sync_all().map_err(io)?;
        }
        std::fs::rename(&tmp, &self.path).map_err(io)
    }

    fn host_id(&self, file: &mut AccountFile) -> Result<String, LlmError> {
        if let Some(id) = &file.host_id {
            return Ok(id.clone());
        }
        let id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        file.host_id = Some(id.clone());
        self.save(file)?;
        Ok(id)
    }

    pub async fn account(&self) -> AccountInfo {
        let file = self.file.lock().await;
        let active = file.active.as_ref().and_then(|id| file.registrations.iter().find(|r| &r.client_id == id));
        let tokens = active.and_then(|r| r.tokens.as_ref());
        AccountInfo {
            signed_in: tokens.is_some(),
            email: active.and_then(|r| r.email.clone()),
            plan_enabled: tokens.is_some_and(TokenSet::plan_enabled),
            show_welcome: tokens.is_some_and(TokenSet::plan_enabled) && !file.welcome_shown,
            has_registration: active.is_some(),
        }
    }

    pub async fn status(&self) -> AuthStatus {
        let info = self.account().await;
        let (ready, kind, message) = if !info.signed_in {
            (false, Some("signin_required"), Some("Sign in with your ChatGPT account to ask questions."))
        } else if !info.plan_enabled {
            (false, Some("plan_not_enabled"), Some("Allow Plato to use your ChatGPT plan to ask questions."))
        } else {
            (true, None, None)
        };
        AuthStatus {
            ready,
            mode: "chatgpt".into(),
            kind: kind.map(str::to_owned),
            message: message.map(str::to_owned),
            account: info.email,
        }
    }

    pub async fn ack_welcome(&self) -> Result<(), LlmError> {
        let mut file = self.file.lock().await;
        file.welcome_shown = true;
        self.save(&file)
    }

    pub fn cancel_sign_in(&self) {
        if let Some(token) = self.sign_in.lock().unwrap().take() {
            token.cancel();
        }
    }

    /// Run the browser sign-in. Resolves once the account is saved.
    pub async fn sign_in(&self, mode: SignInMode) -> Result<AccountInfo, LlmError> {
        let cancel = CancellationToken::new();
        if let Some(previous) = self.sign_in.lock().unwrap().replace(cancel.clone()) {
            previous.cancel();
        }
        let result = tokio::select! {
            r = self.sign_in_inner(mode) => r,
            _ = cancel.cancelled() => Err(LlmError::Cancelled),
            _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err(auth_err("signin_timeout", "Sign-in timed out. Try again.")),
        };
        self.sign_in.lock().unwrap().take();
        result?;
        Ok(self.account().await)
    }

    async fn sign_in_inner(&self, mode: SignInMode) -> Result<(), LlmError> {
        // Which registration this attempt is for.
        let (host_id, existing) = {
            let mut file = self.file.lock().await;
            let host_id = self.host_id(&mut file)?;
            let existing = match mode {
                SignInMode::NewAccount => None,
                _ => file.active.as_ref().and_then(|id| file.registrations.iter().find(|r| &r.client_id == id)).cloned(),
            };
            (host_id, existing)
        };

        let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| auth_err("signin_failed", format!("Could not start the sign-in listener: {e}")))?,
        };
        let port = listener.local_addr().map_err(|e| auth_err("signin_failed", e.to_string()))?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

        let state = random_token();
        let nonce = random_token();
        let verifier = random_token();
        let request_client_id = existing.as_ref().map_or(REGISTRATION_CLIENT_ID, |r| r.client_id.as_str());

        let mut url = reqwest::Url::parse(&self.endpoints.authorize).map_err(|e| LlmError::Protocol(e.to_string()))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("client_id", request_client_id)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("scope", SCOPES)
                .append_pair("resource", &self.endpoints.resource)
                .append_pair("state", &state)
                .append_pair("nonce", &nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &pkce_challenge(&verifier))
                .append_pair("ext_agent_host_id", &host_id);
            match &existing {
                None => {
                    q.append_pair("agent_name_hint", APP_NAME);
                }
                Some(r) => {
                    if let Some(hint) = &r.id_token {
                        q.append_pair("id_token_hint", hint);
                    }
                    if let Some(email) = &r.email {
                        q.append_pair("login_hint", email);
                    }
                }
            }
            if mode == SignInMode::EnablePlan {
                q.append_pair("prompt", "consent");
            }
        }
        (self.open_browser)(url.as_str()).map_err(|e| auth_err("signin_failed", format!("Could not open the browser: {e}")))?;

        let callback = wait_for_callback(&listener, &state).await?;

        // The issued client id: from the callback on first registration,
        // otherwise the saved one (a different one is rejected).
        let client_id = match (&existing, callback.client_id.as_deref()) {
            (None, Some(id)) if id != REGISTRATION_CLIENT_ID => id.to_string(),
            (None, _) => return Err(auth_err("signin_failed", "Registration did not complete (no client id returned).")),
            (Some(r), Some(id)) if id != r.client_id => {
                return Err(auth_err("signin_failed", "The sign-in returned a different app registration."))
            }
            (Some(r), _) => r.client_id.clone(),
        };

        let tokens = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", &callback.code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect_uri),
                ("resource", &self.endpoints.resource),
            ])
            .await
            .map_err(|e| match e {
                TokenError::Oauth(code, msg) => auth_err("signin_failed", format!("Sign-in failed ({code}): {msg}")),
                TokenError::Other(e) => e,
            })?;

        let id_token = tokens.id_token.clone().ok_or_else(|| auth_err("signin_failed", "No ID token returned."))?;
        let claims = self.verify_id_token(&id_token, &client_id, &nonce).await?;
        if let Some(r) = &existing {
            if r.subject != claims.sub {
                return Err(auth_err("signin_failed", "You signed in with a different ChatGPT account than the saved one."));
            }
        }

        let token_set = TokenSet {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scopes: tokens.scope.or(callback.scope).unwrap_or_default().split_whitespace().map(str::to_owned).collect(),
            expires_at: now() + tokens.expires_in.unwrap_or(3600),
            saved_at: now(),
        };
        let mut file = self.file.lock().await;
        let registration = Registration {
            client_id: client_id.clone(),
            subject: claims.sub,
            email: claims.email,
            id_token: Some(id_token),
            tokens: Some(token_set),
        };
        match file.registrations.iter_mut().find(|r| r.client_id == client_id) {
            Some(r) => *r = registration,
            None => file.registrations.push(registration),
        }
        file.active = Some(client_id);
        self.save(&file)
    }

    async fn verify_id_token(&self, id_token: &str, client_id: &str, nonce: &str) -> Result<IdClaims, LlmError> {
        let bad = |m: String| auth_err("signin_failed", format!("The ID token could not be verified: {m}"));
        let header = decode_header(id_token).map_err(|e| bad(e.to_string()))?;
        if header.alg != Algorithm::RS256 {
            return Err(bad(format!("unexpected algorithm {:?}", header.alg)));
        }
        let jwks: JwkSet = self
            .http
            .get(&self.endpoints.jwks)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?
            .error_for_status()
            .map_err(|e| LlmError::Network(e.to_string()))?
            .json()
            .await
            .map_err(|e| bad(e.to_string()))?;
        let jwk = match &header.kid {
            Some(kid) => jwks.find(kid),
            None => jwks.keys.first(),
        }
        .ok_or_else(|| bad("signing key not found".into()))?;
        let key = DecodingKey::from_jwk(jwk).map_err(|e| bad(e.to_string()))?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[client_id]);
        validation.set_issuer(&[&self.endpoints.issuer]);
        let claims = decode::<IdClaims>(id_token, &key, &validation).map_err(|e| bad(e.to_string()))?.claims;
        if claims.nonce.as_deref() != Some(nonce) {
            return Err(bad("nonce mismatch".into()));
        }
        Ok(claims)
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
        let res = self
            .http
            .post(&self.endpoints.token)
            .form(form)
            .send()
            .await
            .map_err(|e| TokenError::Other(LlmError::Network(e.to_string())))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if status.is_success() {
            return serde_json::from_str(&body)
                .map_err(|e| TokenError::Other(LlmError::Protocol(format!("Bad token response: {e}"))));
        }
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        // OAuth errors: {"error": "invalid_grant", "error_description": "..."};
        // some APIs nest {"error": {"code": ..., "message": ...}}.
        let code = parsed["error"].as_str().or_else(|| parsed["error"]["code"].as_str()).map(str::to_owned);
        let message = parsed["error_description"]
            .as_str()
            .or_else(|| parsed["error"]["message"].as_str())
            .unwrap_or("")
            .to_string();
        match code {
            Some(code) if status.is_client_error() => Err(TokenError::Oauth(code, message)),
            _ => Err(TokenError::Other(LlmError::Api {
                status: Some(status.as_u16()),
                kind: "token_endpoint_error".into(),
                message: format!("Token endpoint returned HTTP {status}"),
            })),
        }
    }

    /// A usable access token for the active account, refreshed if needed.
    pub async fn access_token(&self) -> Result<String, LlmError> {
        self.token_inner(false).await
    }

    /// Refresh now (after the API rejected the current token).
    pub async fn refreshed_access_token(&self) -> Result<String, LlmError> {
        self.token_inner(true).await
    }

    async fn token_inner(&self, force: bool) -> Result<String, LlmError> {
        let mut file = self.file.lock().await;
        let active = file.active.clone().ok_or_else(|| auth_err("signin_required", "Sign in with ChatGPT first."))?;
        let reg = file
            .registrations
            .iter()
            .find(|r| r.client_id == active)
            .ok_or_else(|| auth_err("signin_required", "Sign in with ChatGPT first."))?;
        let tokens = reg.tokens.clone().ok_or_else(|| auth_err("signin_required", "Sign in with ChatGPT first."))?;
        if !tokens.plan_enabled() {
            return Err(auth_err("plan_not_enabled", "Allow Plato to use your ChatGPT plan to ask questions."));
        }
        if !force && tokens.expires_at - now() > REFRESH_MARGIN_SECS {
            return Ok(tokens.access_token);
        }

        let Some(refresh_token) = tokens.refresh_token.clone() else {
            return Err(auth_err("signin_required", "Your ChatGPT sign-in expired. Sign in again."));
        };
        let result = self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", &active),
                ("refresh_token", &refresh_token),
                ("resource", &self.endpoints.resource),
            ])
            .await;
        let reg = file.registrations.iter_mut().find(|r| r.client_id == active).expect("registration exists");
        match result {
            Ok(t) => {
                let scopes = t
                    .scope
                    .map(|s| s.split_whitespace().map(str::to_owned).collect())
                    .unwrap_or_else(|| tokens.scopes.clone());
                let fresh = TokenSet {
                    access_token: t.access_token,
                    // Refresh tokens rotate; keep the replacement.
                    refresh_token: t.refresh_token.or(Some(refresh_token)),
                    scopes,
                    expires_at: now() + t.expires_in.unwrap_or(3600),
                    saved_at: now(),
                };
                let access = fresh.access_token.clone();
                reg.tokens = Some(fresh);
                if let Some(id) = t.id_token {
                    reg.id_token = Some(id);
                }
                self.save(&file)?;
                Ok(access)
            }
            Err(TokenError::Oauth(code, _)) if UNUSABLE_REFRESH_CODES.contains(&code.as_str()) => {
                reg.tokens = None;
                self.save(&file)?;
                Err(auth_err("signin_required", "Your ChatGPT sign-in expired or was disconnected. Sign in again."))
            }
            Err(TokenError::Oauth(code, msg)) if code == "invalid_client" => {
                Err(auth_err("invalid_client", format!("ChatGPT rejected this app's registration: {msg}")))
            }
            Err(TokenError::Oauth(code, msg)) => Err(auth_err("refresh_failed", format!("Token refresh failed ({code}): {msg}"))),
            // Network or server trouble: keep the credentials.
            Err(TokenError::Other(e)) => Err(e),
        }
    }

    /// Revoke the session and clear tokens; the registration (client id and
    /// account) is kept for the next sign-in. Returns whether the revocation
    /// was confirmed by OpenAI.
    pub async fn sign_out(&self) -> Result<bool, LlmError> {
        let mut file = self.file.lock().await;
        let Some(active) = file.active.clone() else { return Ok(true) };
        let refresh = file
            .registrations
            .iter()
            .find(|r| r.client_id == active)
            .and_then(|r| r.tokens.as_ref())
            .and_then(|t| t.refresh_token.clone());

        let mut confirmed = refresh.is_none();
        if let Some(token) = refresh {
            for attempt in 0..3 {
                let res = self
                    .http
                    .post(&self.endpoints.revoke)
                    .form(&[("token", token.as_str()), ("token_type_hint", "refresh_token"), ("client_id", active.as_str())])
                    .send()
                    .await;
                match res {
                    Ok(r) if r.status().is_success() => {
                        confirmed = true;
                        break;
                    }
                    Ok(r) if r.status().is_client_error() => break,
                    _ => tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await,
                }
            }
        }
        if let Some(reg) = file.registrations.iter_mut().find(|r| r.client_id == active) {
            reg.tokens = None;
            reg.id_token = None;
        }
        self.save(&file)?;
        Ok(confirmed)
    }
}

enum TokenError {
    /// An OAuth error code from the token endpoint (4xx).
    Oauth(String, String),
    Other(LlmError),
}

struct Callback {
    code: String,
    client_id: Option<String>,
    scope: Option<String>,
}

/// Accept connections on the loopback listener until the OAuth callback
/// arrives; answer it with a small page telling the user to return to Plato.
async fn wait_for_callback(listener: &TcpListener, expected_state: &str) -> Result<Callback, LlmError> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| auth_err("signin_failed", e.to_string()))?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head = loop {
            let n = match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => break None,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break Some(String::from_utf8_lossy(&buf[..end]).into_owned());
            }
            if buf.len() > 16 * 1024 {
                break None;
            }
        };
        let Some(head) = head else { continue };
        let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
        let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if url.path() != CALLBACK_PATH {
            let _ = respond(&mut sock, 404, "Not found").await;
            continue;
        }
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());

        let outcome = if param("state").as_deref() != Some(expected_state) {
            Err(auth_err("signin_failed", "Sign-in response did not match this attempt (state mismatch)."))
        } else if let Some(error) = param("error") {
            if error == "access_denied" {
                Err(auth_err("access_denied", "Sign-in was cancelled in the browser."))
            } else {
                let detail = param("error_description").unwrap_or_default();
                Err(auth_err("signin_failed", format!("Sign-in failed ({error}) {detail}").trim().to_string()))
            }
        } else if let Some(code) = param("code") {
            Ok(Callback { code, client_id: param("client_id"), scope: param("scope") })
        } else {
            Err(auth_err("signin_failed", "Sign-in response had no authorization code."))
        };

        let page = match &outcome {
            Ok(_) => "Signed in. You can close this tab and return to Plato.",
            Err(_) => "Sign-in did not complete. Return to Plato to try again.",
        };
        let _ = respond(&mut sock, 200, page).await;
        return outcome;
    }
}

async fn respond(sock: &mut tokio::net::TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Plato</title>\
         <body style=\"font-family:-apple-system,system-ui,sans-serif;padding:48px;color:#222\">\
         <p>{message}</p></body>"
    );
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(body.as_bytes()).await?;
    sock.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::testutil::{serve, url_decode_pairs, MockServer, Response};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::sync::{Arc, Mutex};

    const KEY_DER: &[u8] = include_bytes!("testdata/test-signing-key.der");
    const KEY_N: &str = include_str!("testdata/test-signing-key.n.txt");
    const ISSUED: &str = "oaiapp_test123";

    fn id_token(issuer: &str, aud: &str, sub: &str, nonce: &str) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let claims = serde_json::json!({
            "iss": issuer, "aud": aud, "sub": sub, "email": "reader@example.com",
            "nonce": nonce, "exp": now() + 3600, "iat": now(),
        });
        encode(&header, &claims, &EncodingKey::from_rsa_der(KEY_DER)).unwrap()
    }

    /// Mock OpenAI auth: JWKS, token (code + refresh), revoke. The nonce is
    /// learned from the authorize URL the fake browser "opens".
    struct MockAuth {
        server: MockServer,
        nonce: Arc<Mutex<String>>,
        refresh_error: Arc<Mutex<Option<&'static str>>>,
    }

    async fn mock_auth(sub: &'static str, scope: &'static str) -> MockAuth {
        let nonce = Arc::new(Mutex::new(String::new()));
        let refresh_error: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(None));
        let issuer_cell: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let (n2, r2, i2) = (nonce.clone(), refresh_error.clone(), issuer_cell.clone());
        let server = serve(move |req| {
            if req.target.starts_with("/jwks") {
                let jwks = serde_json::json!({ "keys": [{
                    "kty": "RSA", "kid": "test-key", "alg": "RS256", "use": "sig",
                    "n": KEY_N.trim(), "e": "AQAB"
                }]});
                return Response::json(200, jwks.to_string());
            }
            if req.target.starts_with("/revoke") {
                return Response::json(200, "");
            }
            let form: std::collections::HashMap<_, _> = req.form().into_iter().collect();
            if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                if let Some(code) = *r2.lock().unwrap() {
                    return Response::json(400, format!(r#"{{"error":"{code}","error_description":"nope"}}"#));
                }
                return Response::json(
                    200,
                    serde_json::json!({ "access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600, "token_type": "Bearer" }).to_string(),
                );
            }
            // authorization_code exchange
            assert_eq!(form["client_id"], ISSUED);
            assert_eq!(form["code"], "the-code");
            assert!(form["redirect_uri"].starts_with("http://127.0.0.1:"));
            assert_eq!(form["resource"], "https://api.openai.com/v1");
            assert!(!form["code_verifier"].is_empty());
            let token = id_token(&i2.lock().unwrap(), ISSUED, sub, &n2.lock().unwrap());
            Response::json(
                200,
                serde_json::json!({
                    "access_token": "access-1", "refresh_token": "refresh-1", "id_token": token,
                    "token_type": "Bearer", "expires_in": 3600, "scope": scope
                })
                .to_string(),
            )
        })
        .await;
        *issuer_cell.lock().unwrap() = server.url.clone();
        MockAuth { server, nonce, refresh_error }
    }

    fn endpoints(url: &str) -> Endpoints {
        Endpoints {
            issuer: url.to_string(),
            authorize: format!("{url}/authorize"),
            token: format!("{url}/token"),
            revoke: format!("{url}/revoke"),
            jwks: format!("{url}/jwks"),
            resource: "https://api.openai.com/v1".into(),
        }
    }

    /// A fake browser: records the authorize URL, then hits the loopback
    /// callback the way OpenAI's redirect would.
    fn fake_browser(
        nonce: Arc<Mutex<String>>,
        seen: Arc<Mutex<Vec<String>>>,
        return_client_id: bool,
    ) -> BrowserOpener {
        Box::new(move |url: &str| {
            seen.lock().unwrap().push(url.to_string());
            let params: std::collections::HashMap<_, _> =
                url_decode_pairs(url.split_once('?').unwrap().1).into_iter().collect();
            *nonce.lock().unwrap() = params["nonce"].clone();
            let mut cb = format!("{}?code=the-code&state={}", params["redirect_uri"], params["state"]);
            cb.push_str("&scope=chatgpt.tokens.use.direct+email+offline_access+openid+profile+resource.invoke");
            if return_client_id {
                cb.push_str(&format!("&client_id={ISSUED}"));
            }
            tokio::spawn(async move {
                reqwest::get(cb).await.unwrap();
            });
            Ok(())
        })
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plato-chatgpt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("chatgpt-accounts.json")
    }

    #[tokio::test]
    async fn first_sign_in_registers_and_saves_credentials() {
        let mock = mock_auth("user-1", "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke").await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let path = temp_path("first");
        let auth = ChatGptAuth::new(path.clone(), endpoints(&mock.server.url), fake_browser(mock.nonce.clone(), seen.clone(), true));

        let info = auth.sign_in(SignInMode::Continue).await.unwrap();
        assert_eq!(
            info,
            AccountInfo {
                signed_in: true,
                email: Some("reader@example.com".into()),
                plan_enabled: true,
                show_welcome: true,
                has_registration: true
            }
        );

        // The authorize request follows the documented first-registration shape.
        let url = seen.lock().unwrap()[0].clone();
        let q: std::collections::HashMap<_, _> = url_decode_pairs(url.split_once('?').unwrap().1).into_iter().collect();
        assert!(url.starts_with(&format!("{}/authorize?", mock.server.url)));
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(q["agent_name_hint"], "Plato");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["resource"], "https://api.openai.com/v1");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(q["ext_agent_host_id"].starts_with("urn:uuid:"));
        assert!(q["redirect_uri"].starts_with("http://127.0.0.1:") && q["redirect_uri"].ends_with("/auth/callback"));
        assert!(!q.contains_key("id_token_hint"));

        // Saved with owner-only permissions; the issued id, not the registration entrypoint.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains(ISSUED) && !raw.contains("\"dynamic_agent_client\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(auth.access_token().await.unwrap(), "access-1");
        assert!(auth.status().await.ready);
    }

    #[tokio::test]
    async fn returning_sign_in_reuses_client_id_and_hints() {
        let mock = mock_auth("user-1", "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke").await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let path = temp_path("again");
        let auth = ChatGptAuth::new(path.clone(), endpoints(&mock.server.url), fake_browser(mock.nonce.clone(), seen.clone(), true));
        auth.sign_in(SignInMode::Continue).await.unwrap();
        let host_before = auth.file.lock().await.host_id.clone();
        assert!(auth.sign_out().await.unwrap(), "revocation confirmed");
        assert!(!auth.account().await.signed_in);

        // Second sign-in: issued client id, no agent_name_hint, same host id.
        let again = ChatGptAuth::new(path, endpoints(&mock.server.url), fake_browser(mock.nonce.clone(), seen.clone(), false));
        again.sign_in(SignInMode::Continue).await.unwrap();
        let url = seen.lock().unwrap()[1].clone();
        let q: std::collections::HashMap<_, _> = url_decode_pairs(url.split_once('?').unwrap().1).into_iter().collect();
        assert_eq!(q["client_id"], ISSUED);
        assert!(!q.contains_key("agent_name_hint"));
        assert_eq!(q["login_hint"], "reader@example.com");
        assert_eq!(Some(q["ext_agent_host_id"].clone()), host_before);

        let revoke = mock.server.requests.lock().unwrap().iter().find(|r| r.target.starts_with("/revoke")).cloned().unwrap();
        let form: std::collections::HashMap<_, _> = revoke.form().into_iter().collect();
        assert_eq!(form["token"], "refresh-1");
        assert_eq!(form["token_type_hint"], "refresh_token");
        assert_eq!(form["client_id"], ISSUED);
    }

    #[tokio::test]
    async fn plan_scope_missing_blocks_inference() {
        let mock = mock_auth("user-1", "email openid profile offline_access").await;
        let auth = ChatGptAuth::new(
            temp_path("noplan"),
            endpoints(&mock.server.url),
            fake_browser(mock.nonce.clone(), Arc::new(Mutex::new(Vec::new())), true),
        );
        let info = auth.sign_in(SignInMode::Continue).await.unwrap();
        assert!(info.signed_in && !info.plan_enabled && !info.show_welcome);
        assert!(matches!(auth.access_token().await.unwrap_err(), LlmError::Auth { kind: "plan_not_enabled", .. }));
        assert_eq!(auth.status().await.kind.as_deref(), Some("plan_not_enabled"));
    }

    #[tokio::test]
    async fn refresh_rotates_tokens_and_unusable_refresh_signs_out() {
        let mock = mock_auth("user-1", "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke").await;
        let auth = ChatGptAuth::new(
            temp_path("refresh"),
            endpoints(&mock.server.url),
            fake_browser(mock.nonce.clone(), Arc::new(Mutex::new(Vec::new())), true),
        );
        auth.sign_in(SignInMode::Continue).await.unwrap();

        assert_eq!(auth.refreshed_access_token().await.unwrap(), "access-2");
        let refresh = mock.server.requests.lock().unwrap().iter().rev().find(|r| r.body.contains("refresh_token")).cloned().unwrap();
        let form: std::collections::HashMap<_, _> = refresh.form().into_iter().collect();
        assert_eq!(form["client_id"], ISSUED);
        assert_eq!(form["refresh_token"], "refresh-1");
        assert_eq!(form["resource"], "https://api.openai.com/v1");
        assert!(!form.contains_key("scope"), "omit scope to keep the grant");
        assert!(auth.file.lock().await.registrations[0].tokens.as_ref().unwrap().refresh_token.as_deref() == Some("refresh-2"));

        *mock.refresh_error.lock().unwrap() = Some("refresh_token_reused");
        let err = auth.refreshed_access_token().await.unwrap_err();
        assert!(matches!(err, LlmError::Auth { kind: "signin_required", .. }));
        let info = auth.account().await;
        assert!(!info.signed_in && info.has_registration, "tokens cleared, registration kept");
    }

    #[tokio::test]
    async fn rejects_wrong_state_and_access_denied() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            reqwest::get(format!("http://127.0.0.1:{port}/favicon.ico")).await.unwrap();
            reqwest::get(format!("http://127.0.0.1:{port}/auth/callback?code=x&state=wrong")).await.unwrap();
        });
        let err = wait_for_callback(&listener, "right").await.err().unwrap();
        assert!(err.to_string().contains("state mismatch"));

        tokio::spawn(async move {
            reqwest::get(format!("http://127.0.0.1:{port}/auth/callback?error=access_denied&state=right")).await.unwrap();
        });
        assert!(matches!(wait_for_callback(&listener, "right").await.err().unwrap(), LlmError::Auth { kind: "access_denied", .. }));
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
