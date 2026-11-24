//! OpenAI via "Sign in with ChatGPT": model calls go to the public Responses
//! API with the user's OAuth access token and are billed to their ChatGPT
//! plan. Requirements from the preview docs: `store: false`, `stream: true`,
//! history sent in `input`, system prompt as `instructions`, and no
//! `temperature` / `max_output_tokens` / `previous_response_id`.

pub mod auth;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use self::auth::ChatGptAuth;
use super::sse::SseParser;
use super::{AuthStatus, ChatRequest, EventSink, LlmError, ModelInfo, Provider, StreamEvent, Usage};

pub const PROVIDER_ID: &str = "openai";
const DEFAULT_API_BASE: &str = "https://api.openai.com/v1";
/// Bounded backoff for 503s ("temporarily unavailable") before any output.
const MAX_RETRIES: u32 = 2;

pub struct OpenAIProvider {
    http: reqwest::Client,
    api_base: String,
    auth: Arc<ChatGptAuth>,
    models: Mutex<Option<Vec<ModelInfo>>>,
}

impl OpenAIProvider {
    pub fn new(auth: Arc<ChatGptAuth>) -> Self {
        Self::with_api_base(auth, DEFAULT_API_BASE)
    }

    pub fn with_api_base(auth: Arc<ChatGptAuth>, api_base: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build HTTP client");
        Self { http, api_base: api_base.trim_end_matches('/').to_string(), auth, models: Mutex::new(None) }
    }

    pub fn forget_models(&self) {
        *self.models.lock().unwrap() = None;
    }

    /// Send with the current token; on 401 refresh once and retry; on 503
    /// back off and retry. Errors keep the server's code and request id.
    async fn send(&self, build: impl Fn(&str) -> reqwest::RequestBuilder) -> Result<reqwest::Response, LlmError> {
        let mut token = self.auth.access_token().await?;
        let mut refreshed = false;
        let mut attempt = 0;
        loop {
            let res = build(&token).bearer_auth(&token).send().await.map_err(|e| LlmError::Network(e.to_string()))?;
            let status = res.status().as_u16();
            if res.status().is_success() {
                return Ok(res);
            }
            let request_id = res.headers().get("x-request-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
            let err = api_error(Some(status), &res.text().await.unwrap_or_default(), request_id.as_deref());
            if status == 401 && !refreshed {
                refreshed = true;
                token = self.auth.refreshed_access_token().await?;
                continue;
            }
            let retryable = status == 503 && !matches!(&err, LlmError::Api { kind, .. } if kind == "subscription_sharing_user_not_eligible");
            if retryable && attempt < MAX_RETRIES {
                tokio::time::sleep(Duration::from_millis(1000 * 2u64.pow(attempt))).await;
                attempt += 1;
                continue;
            }
            return Err(err);
        }
    }
}

/// Friendly text for the documented plan-usage error codes.
fn describe(code: &str, server_message: &str, param: Option<&str>) -> String {
    match code {
        "subscription_sharing_usage_limit_exceeded" => {
            "Usage limit reached for your ChatGPT plan in this app. Manage usage in ChatGPT settings.".into()
        }
        "subscription_sharing_user_not_eligible" => {
            "ChatGPT plan usage isn't available for this account or workspace.".into()
        }
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            "ChatGPT plan usage is temporarily unavailable. Try again in a moment.".into()
        }
        "subscription_sharing_invalid_user" => "Your ChatGPT sign-in couldn't be validated. Sign in again.".into(),
        "subscription_sharing_unsupported_capability" => {
            format!("This request uses something ChatGPT plan usage doesn't support{}.", param.map(|p| format!(" ({p})")).unwrap_or_default())
        }
        _ if !server_message.is_empty() => server_message.to_string(),
        _ => code.to_string(),
    }
}

/// Errors come as `{"error": {"code", "message", "param"}}`, or before a
/// stream opens possibly as `{"detail": "..."}`.
fn api_error(status: Option<u16>, body: &str, request_id: Option<&str>) -> LlmError {
    let v: Value = serde_json::from_str(body).unwrap_or_default();
    let err = &v["error"];
    let code = err["code"].as_str().or_else(|| err["type"].as_str()).map(str::to_owned);
    let server_message = err["message"].as_str().or_else(|| v["detail"].as_str()).unwrap_or("").to_string();
    let kind = code.clone().unwrap_or_else(|| status.map_or("api_error".into(), |s| format!("http_{s}")));
    let mut message = match &code {
        Some(c) => describe(c, &server_message, err["param"].as_str()),
        None if !server_message.is_empty() => server_message,
        None => match status {
            Some(401) => "ChatGPT didn't accept this sign-in. Check the selected account.".into(),
            Some(403) => "ChatGPT plan usage isn't permitted here (for example, region or policy).".into(),
            Some(503) => "ChatGPT plan usage is temporarily unavailable. Try again in a moment.".into(),
            Some(s) => format!("HTTP {s}: {}", body.chars().take(200).collect::<String>()),
            None => body.chars().take(200).collect(),
        },
    };
    if let Some(id) = request_id {
        message.push_str(&format!(" (request {id})"));
    }
    LlmError::Api { status, kind, message }
}

pub(crate) fn request_body(req: &ChatRequest, model: &str) -> Value {
    let input: Vec<Value> = req.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect();
    let mut body = json!({ "model": model, "input": input, "store": false, "stream": true });
    if !req.system.is_empty() {
        body["instructions"] = json!(req.system);
    }
    if let Some(effort) = &req.effort {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

/// Maps Responses API stream events to [`StreamEvent`]s.
#[derive(Default)]
pub(crate) struct EventMapper {
    refused: bool,
    pub finished: bool,
}

impl EventMapper {
    pub fn handle(&mut self, data: &str, sink: EventSink<'_>) -> Result<(), LlmError> {
        let v: Value = serde_json::from_str(data).map_err(|e| LlmError::Protocol(format!("bad event JSON: {e}")))?;
        match v["type"].as_str().unwrap_or_default() {
            "response.created" => {
                let model = v["response"]["model"].as_str().unwrap_or_default().to_string();
                sink(StreamEvent::Started { model });
            }
            "response.output_text.delta" => {
                sink(StreamEvent::TextDelta { text: v["delta"].as_str().unwrap_or_default().to_string() });
            }
            "response.refusal.delta" => {
                self.refused = true;
                sink(StreamEvent::TextDelta { text: v["delta"].as_str().unwrap_or_default().to_string() });
            }
            "response.completed" => {
                self.finished = true;
                let stop = if self.refused { "refusal" } else { "end_turn" };
                sink(StreamEvent::Finished { stop_reason: Some(stop.into()), usage: usage(&v["response"]["usage"]) });
            }
            "response.incomplete" => {
                self.finished = true;
                let reason = v["response"]["incomplete_details"]["reason"].as_str().unwrap_or("incomplete");
                let stop = match reason {
                    "max_output_tokens" => "max_tokens",
                    "content_filter" => "refusal",
                    other => other,
                };
                sink(StreamEvent::Finished { stop_reason: Some(stop.into()), usage: usage(&v["response"]["usage"]) });
            }
            "response.failed" => {
                let body = json!({ "error": v["response"]["error"] }).to_string();
                return Err(api_error(None, &body, None));
            }
            "error" => {
                let body = json!({ "error": { "code": v["code"], "message": v["message"], "param": v["param"] } }).to_string();
                return Err(api_error(None, &body, None));
            }
            _ => {}
        }
        Ok(())
    }
}

fn usage(u: &Value) -> Usage {
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    Usage {
        input_tokens: n(&u["input_tokens"]),
        output_tokens: n(&u["output_tokens"]),
        cache_read_input_tokens: n(&u["input_tokens_details"]["cached_tokens"]),
        cache_creation_input_tokens: 0,
    }
}

#[async_trait]
impl Provider for OpenAIProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    /// The first model the signed-in account's catalog lists.
    async fn default_model(&self) -> Result<String, LlmError> {
        self.list_models()
            .await?
            .first()
            .map(|m| m.id.clone())
            .ok_or_else(|| LlmError::Protocol("No models are available for this ChatGPT account.".into()))
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        if let Some(models) = self.models.lock().unwrap().clone() {
            return Ok(models);
        }
        let url = format!("{}/models", self.api_base);
        let res = self.send(|_| self.http.get(&url)).await?;
        let body: Value = res.json().await.map_err(|e| LlmError::Protocol(e.to_string()))?;
        let models: Vec<ModelInfo> = body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["visibility"] == "list")
            .filter_map(|m| {
                let id = m["slug"].as_str()?.to_string();
                let display_name = m["display_name"].as_str().unwrap_or(&id).to_string();
                Some(ModelInfo { id, display_name })
            })
            .collect();
        *self.models.lock().unwrap() = Some(models.clone());
        Ok(models)
    }

    async fn stream_chat(&self, request: &ChatRequest, sink: EventSink<'_>) -> Result<(), LlmError> {
        let model = match &request.model {
            Some(m) => m.clone(),
            None => self.default_model().await?,
        };
        let url = format!("{}/responses", self.api_base);
        let body = request_body(request, &model);
        let res = self.send(|_| self.http.post(&url).json(&body)).await?;

        let mut parser = SseParser::default();
        let mut mapper = EventMapper::default();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| LlmError::Network(e.to_string()))?;
            for event in parser.push(&chunk) {
                mapper.handle(&event.data, sink)?;
            }
        }
        if !mapper.finished {
            return Err(LlmError::Protocol("The reply stream ended before it completed.".into()));
        }
        Ok(())
    }

    async fn auth_status(&self) -> AuthStatus {
        self.auth.status().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::testutil::{serve, Response};
    use crate::llm::{ChatMessage, Role};

    fn request() -> ChatRequest {
        ChatRequest {
            model: Some("gpt-test".into()),
            system: "You are a reading assistant.".into(),
            messages: vec![
                ChatMessage { role: Role::User, content: "What is attention?".into() },
                ChatMessage { role: Role::Assistant, content: "A weighting.".into() },
                ChatMessage { role: Role::User, content: "More?".into() },
            ],
            max_tokens: Some(1000),
            effort: None,
        }
    }

    #[test]
    fn body_follows_plan_usage_requirements() {
        let body = request_body(&request(), "gpt-test");
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "You are a reading assistant.");
        assert_eq!(body["input"][1], json!({ "role": "assistant", "content": "A weighting." }));
        for unsupported in ["max_output_tokens", "temperature", "previous_response_id", "metadata", "truncation"] {
            assert!(body.get(unsupported).is_none(), "{unsupported} must not be sent");
        }
        assert!(!body["input"].as_array().unwrap().iter().any(|m| m["role"] == "system"));
    }

    const STREAM: &str = concat!(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-test\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Attention \"}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"weighs tokens.\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":50,\"output_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":32}}}}\n\n",
    );

    #[test]
    fn maps_stream_events() {
        let events = Mutex::new(Vec::new());
        let sink = |e: StreamEvent| events.lock().unwrap().push(e);
        let mut m = EventMapper::default();
        for block in STREAM.split("\n\n").filter(|b| !b.is_empty()) {
            m.handle(block.lines().nth(1).unwrap().strip_prefix("data: ").unwrap(), &sink).unwrap();
        }
        assert!(m.finished);
        assert_eq!(
            events.into_inner().unwrap(),
            vec![
                StreamEvent::Started { model: "gpt-test".into() },
                StreamEvent::TextDelta { text: "Attention ".into() },
                StreamEvent::TextDelta { text: "weighs tokens.".into() },
                StreamEvent::Finished {
                    stop_reason: Some("end_turn".into()),
                    usage: Usage { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 32, cache_creation_input_tokens: 0 },
                },
            ]
        );
    }

    #[test]
    fn failed_and_incomplete_streams() {
        let mut m = EventMapper::default();
        let err = m
            .handle(
                r#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}}"#,
                &|_| {},
            )
            .unwrap_err();
        match err {
            LlmError::Api { kind, message, .. } => {
                assert_eq!(kind, "subscription_sharing_usage_limit_exceeded");
                assert!(message.starts_with("Usage limit reached"));
            }
            other => panic!("{other:?}"),
        }
        let events = Mutex::new(Vec::new());
        let mut m = EventMapper::default();
        m.handle(
            r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{}}}"#,
            &|e| events.lock().unwrap().push(e),
        )
        .unwrap();
        assert!(matches!(&events.lock().unwrap()[0], StreamEvent::Finished { stop_reason: Some(r), .. } if r == "max_tokens"));
    }

    #[test]
    fn admission_errors_keep_status_and_request_id() {
        let e = api_error(Some(503), r#"{"detail":"Direct routing is unavailable"}"#, Some("req_123"));
        match e {
            LlmError::Api { status, kind, message } => {
                assert_eq!(status, Some(503));
                assert_eq!(kind, "http_503");
                assert_eq!(message, "Direct routing is unavailable (request req_123)");
            }
            other => panic!("{other:?}"),
        }
        let e = api_error(
            Some(400),
            r#"{"error":{"code":"subscription_sharing_unsupported_capability","param":"tools[0]","message":"x"}}"#,
            None,
        );
        assert!(e.to_string().contains("(tools[0])"));
    }

    /// End to end against a mock API, with a signed-in account file.
    #[tokio::test]
    async fn streams_and_lists_models_with_bearer_token() {
        let api = serve(|req| {
            if req.target == "/v1/models" {
                return Response::json(
                    200,
                    r#"{"models":[{"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide"},{"slug":"gpt-test","display_name":"GPT Test","visibility":"list"}]}"#,
                );
            }
            Response::sse(STREAM)
        })
        .await;

        let dir = std::env::temp_dir().join(format!("plato-openai-provider-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chatgpt-accounts.json");
        let far_future = 4_000_000_000i64;
        std::fs::write(
            &path,
            json!({
                "host_id": "urn:uuid:test", "active": "oaiapp_x", "welcome_shown": true,
                "registrations": [{ "client_id": "oaiapp_x", "subject": "s", "email": "r@example.com", "id_token": null,
                    "tokens": { "access_token": "tok-abc", "refresh_token": "r", "scopes": ["chatgpt.tokens.use.direct"],
                                "expires_at": far_future, "saved_at": 0 } }]
            })
            .to_string(),
        )
        .unwrap();
        let auth = Arc::new(ChatGptAuth::new(path, auth::Endpoints::default(), Box::new(|_| Ok(()))));
        let p = OpenAIProvider::with_api_base(auth, &format!("{}/v1", api.url));

        let models = p.list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-test");
        assert_eq!(p.default_model().await.unwrap(), "gpt-test");

        let mut req = request();
        req.model = None;
        let events = Mutex::new(Vec::new());
        p.stream_chat(&req, &|e| events.lock().unwrap().push(e)).await.unwrap();
        assert_eq!(events.lock().unwrap().len(), 4);

        let reqs = api.requests.lock().unwrap();
        let post = reqs.iter().find(|r| r.method == "POST").unwrap();
        assert_eq!(post.target, "/v1/responses");
        assert_eq!(post.header("authorization"), Some("Bearer tok-abc"));
        let body: Value = serde_json::from_str(&post.body).unwrap();
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
    }
}
