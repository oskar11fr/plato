//! LLM access. Every model call goes through a [`Provider`]; the web view only
//! sends a [`ChatRequest`] and receives [`StreamEvent`]s. API keys stay in the
//! backend (OS keychain) and never reach the web view.

pub mod anthropic;
mod sse;

use async_trait::async_trait;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::secrets;

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
    #[serde(default)]
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
    /// The provider switched models mid-reply (e.g. after a safety refusal).
    Fallback { from: String, to: String },
    /// `stop_reason` is provider-specific ("end_turn", "max_tokens", "refusal", ...).
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
    #[error("No API key set for {0}")]
    MissingKey(String),
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
    fn kind(&self) -> &str {
        match self {
            LlmError::MissingKey(_) => "missing_key",
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

pub type EventSink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn default_model(&self) -> &'static str;
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError>;
    /// Stream one reply, sending events to `sink` as they arrive. Returns once
    /// the reply has finished. Dropping the future cancels the request.
    async fn stream_chat(&self, request: &ChatRequest, sink: EventSink<'_>) -> Result<(), LlmError>;
}

pub struct LlmState {
    providers: HashMap<&'static str, Arc<dyn Provider>>,
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl LlmState {
    pub fn new() -> Self {
        let anthropic: Arc<dyn Provider> = Arc::new(anthropic::AnthropicProvider::new(Box::new(|| {
            secrets::get_api_key(anthropic::PROVIDER_ID)
        })));
        let providers = HashMap::from([(anthropic.id(), anthropic)]);
        Self { providers, running: Mutex::new(HashMap::new()) }
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
pub fn llm_default_model(provider: String, state: State<'_, LlmState>) -> Result<String, LlmError> {
    Ok(state.provider(&provider)?.default_model().to_string())
}
