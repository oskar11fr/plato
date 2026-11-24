//! LLM access. Every model call goes through a [`Provider`]; the web view only
//! sends a [`ChatRequest`] and receives [`StreamEvent`]s. Credentials stay in
//! the backend and never reach the web view.

pub mod openai;
mod sse;
#[cfg(test)]
mod testutil;

use async_trait::async_trait;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use openai::auth::{AccountInfo, BrowserOpener, ChatGptAuth, Endpoints, SignInMode};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// A provider-neutral chat request.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// Model id; `None` uses the provider's default.
    #[serde(default)]
    pub model: Option<String>,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    /// Output cap, where the provider supports one.
    #[serde(default)]
    #[allow(dead_code)]
    pub max_tokens: Option<u32>,
    /// Reasoning effort hint ("low" | "medium" | "high" ...), where supported.
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

/// What the web view receives while a reply streams.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// The reply started; `model` is the model actually serving it.
    Started { model: String },
    TextDelta { text: String },
    /// `stop_reason` is normalized: "end_turn", "max_tokens", "refusal", or
    /// a provider-specific value.
    Finished { stop_reason: Option<String>, usage: Usage },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

#[derive(thiserror::Error, Debug)]
pub enum LlmError {
    /// Sign-in is needed or failed.
    #[error("{message}")]
    Auth { kind: &'static str, message: String },
    #[error("Unknown provider: {0}")]
    UnknownProvider(String),
    /// An error reported by the provider's API. `status` is `None` for errors
    /// that arrive inside an already-open stream.
    #[error("{message}")]
    Api { status: Option<u16>, kind: String, message: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Unexpected response: {0}")]
    Protocol(String),
    #[error("Cancelled")]
    Cancelled,
}

impl LlmError {
    pub(crate) fn kind(&self) -> &str {
        match self {
            LlmError::Auth { kind, .. } => kind,
            LlmError::UnknownProvider(_) => "unknown_provider",
            LlmError::Api { kind, .. } => kind,
            LlmError::Network(_) => "network",
            LlmError::Protocol(_) => "protocol",
            LlmError::Cancelled => "cancelled",
        }
    }
}

/// Sent to the web view as `{ kind, message }`.
impl Serialize for LlmError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("LlmError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// Whether a provider can make requests right now, and if not, why.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub ready: bool,
    /// Provider-specific sign-in method, e.g. "chatgpt".
    pub mode: String,
    pub kind: Option<String>,
    pub message: Option<String>,
    /// The signed-in account, for display.
    pub account: Option<String>,
}

pub type EventSink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn default_model(&self) -> Result<String, LlmError>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError>;
    /// Stream one reply, sending events to `sink` as they arrive. Returns once
    /// the reply has finished. Dropping the future cancels the request.
    async fn stream_chat(&self, request: &ChatRequest, sink: EventSink<'_>) -> Result<(), LlmError>;
    /// Check credentials without calling the model.
    async fn auth_status(&self) -> AuthStatus;
}

pub struct LlmState {
    providers: HashMap<&'static str, Arc<dyn Provider>>,
    openai: Arc<openai::OpenAIProvider>,
    chatgpt: Arc<ChatGptAuth>,
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl LlmState {
    /// `open_browser` opens the sign-in page in the system browser.
    pub fn new(config_dir: PathBuf, open_browser: BrowserOpener) -> Self {
        let chatgpt =
            Arc::new(ChatGptAuth::new(config_dir.join("chatgpt-accounts.json"), Endpoints::default(), open_browser));
        let openai = Arc::new(openai::OpenAIProvider::new(chatgpt.clone()));
        let as_provider: Arc<dyn Provider> = openai.clone();
        let providers = HashMap::from([(as_provider.id(), as_provider)]);
        Self { providers, openai, chatgpt, running: Mutex::new(HashMap::new()) }
    }

    fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, LlmError> {
        self.providers.get(id).cloned().ok_or_else(|| LlmError::UnknownProvider(id.to_string()))
    }
}

/// Stream a reply into `on_event`. Resolves when the reply is complete, and
/// rejects with `{ kind, message }` on error or cancellation.
#[tauri::command]
pub async fn llm_ask(
    provider: String,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    state: State<'_, LlmState>,
) -> Result<(), LlmError> {
    let provider = state.provider(&provider)?;
    let token = CancellationToken::new();
    state.running.lock().unwrap().insert(request_id.clone(), token.clone());

    let sink = |event: StreamEvent| {
        let _ = on_event.send(event);
    };
    let result = tokio::select! {
        r = provider.stream_chat(&request, &sink) => r,
        _ = token.cancelled() => Err(LlmError::Cancelled),
    };

    state.running.lock().unwrap().remove(&request_id);
    result
}

#[tauri::command]
pub fn llm_cancel(request_id: String, state: State<'_, LlmState>) {
    if let Some(token) = state.running.lock().unwrap().remove(&request_id) {
        token.cancel();
    }
}

#[tauri::command]
pub async fn llm_list_models(provider: String, state: State<'_, LlmState>) -> Result<Vec<ModelInfo>, LlmError> {
    state.provider(&provider)?.list_models().await
}

#[tauri::command]
pub async fn llm_default_model(provider: String, state: State<'_, LlmState>) -> Result<String, LlmError> {
    state.provider(&provider)?.default_model().await
}

#[tauri::command]
pub async fn llm_auth_status(provider: String, state: State<'_, LlmState>) -> Result<AuthStatus, LlmError> {
    Ok(state.provider(&provider)?.auth_status().await)
}

// ---- Sign in with ChatGPT --------------------------------------------------

/// Opens the browser and resolves once the account is signed in.
#[tauri::command]
pub async fn chatgpt_sign_in(mode: SignInMode, state: State<'_, LlmState>) -> Result<AccountInfo, LlmError> {
    let info = state.chatgpt.sign_in(mode).await?;
    state.openai.forget_models(); // the model catalog is per account
    Ok(info)
}

#[tauri::command]
pub fn chatgpt_cancel_sign_in(state: State<'_, LlmState>) {
    state.chatgpt.cancel_sign_in();
}

/// Returns whether OpenAI confirmed the revocation.
#[tauri::command]
pub async fn chatgpt_sign_out(state: State<'_, LlmState>) -> Result<bool, LlmError> {
    state.openai.forget_models();
    state.chatgpt.sign_out().await
}

#[tauri::command]
pub async fn chatgpt_account(state: State<'_, LlmState>) -> Result<AccountInfo, LlmError> {
    Ok(state.chatgpt.account().await)
}

#[tauri::command]
pub async fn chatgpt_ack_welcome(state: State<'_, LlmState>) -> Result<(), LlmError> {
    state.chatgpt.ack_welcome().await
}
