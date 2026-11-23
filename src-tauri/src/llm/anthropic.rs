//! Anthropic Messages API over raw HTTP (there is no official Rust SDK).

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

use super::sse::SseParser;
use super::{ChatRequest, EventSink, LlmError, ModelInfo, Provider, StreamEvent, Usage};

pub const PROVIDER_ID: &str = "anthropic";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2026-10-21";
const DEFAULT_MODEL: &str = "claude-opus-5-5";
const DEFAULT_MAX_TOKENS: u32 = 64_000;
const MAX_RETRIES: u32 = 2;

/// Server-side fallback: if a safety classifier declines the request, the
/// API re-runs it on a fallback model inside the same call and stream.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS: &[&str] = &[
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-sonnet-5-5",
];

type KeySource = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct AnthropicProvider {
    http: reqwest::Client,
    base_url: String,
    api_key: KeySource,
}

impl AnthropicProvider {
    pub fn new(api_key: KeySource) -> Self {
        Self::with_base_url(api_key, DEFAULT_BASE_URL)
    }

    pub fn with_base_url(api_key: KeySource, base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build HTTP client");
        Self { http, base_url: base_url.trim_end_matches('/').to_string(), api_key }
    }

    fn key(&self) -> Result<String, LlmError> {
        (self.api_key)().ok_or_else(|| LlmError::MissingKey("Anthropic".into()))
    }

    /// Send a request, retrying connection errors, 408/409/429 and 5xx
    /// (honouring `retry-after` and `x-should-retry`) before any output.
    async fn send(&self, build: impl Fn() -> reqwest::RequestBuilder) -> Result<reqwest::Response, LlmError> {
        let mut attempt = 0;
        loop {
            match build().send().await {
                Ok(res) if res.status().is_success() => return Ok(res),
                Ok(res) => {
                    let status = res.status().as_u16();
                    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
                    let should_retry = match header("x-should-retry").as_deref() {
                        Some("true") => true,
                        Some("false") => false,
                        _ => matches!(status, 408 | 409 | 429) || status >= 500,
                    };
                    let retry_after = header("retry-after").and_then(|v| v.parse::<f64>().ok());
                    let err = api_error(Some(status), &res.text().await.unwrap_or_default());
                    if !should_retry || attempt >= MAX_RETRIES {
                        return Err(err);
                    }
                    tokio::time::sleep(backoff(attempt, retry_after)).await;
                }
                Err(e) if (e.is_connect() || e.is_timeout()) && attempt < MAX_RETRIES => {
                    tokio::time::sleep(backoff(attempt, None)).await;
                }
                Err(e) => return Err(LlmError::Network(e.to_string())),
            }
            attempt += 1;
        }
    }
}

fn backoff(attempt: u32, retry_after: Option<f64>) -> Duration {
    match retry_after {
        Some(secs) if secs >= 0.0 => Duration::from_secs_f64(secs.min(30.0)),
        _ => Duration::from_millis(500 * 2u64.pow(attempt)),
    }
}

/// Parse `{"type":"error","error":{"type":...,"message":...}}`.
fn api_error(status: Option<u16>, body: &str) -> LlmError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let error = parsed.as_ref().and_then(|v| v.get("error"));
    let kind = error.and_then(|e| e["type"].as_str()).unwrap_or("api_error").to_string();
    let message = error
        .and_then(|e| e["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| match status {
            Some(s) => format!("HTTP {s}: {}", body.chars().take(300).collect::<String>()),
            None => body.chars().take(300).collect(),
        });
    LlmError::Api { status, kind, message }
}

pub(crate) fn request_body(req: &ChatRequest) -> Value {
    let model = req.model.as_deref().unwrap_or(DEFAULT_MODEL);
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
        "messages": messages,
        // Auto-cache the conversation prefix: each turn re-sends the same
        // history, so the next request reads it from cache.
        "cache_control": { "type": "ephemeral" },
    });
    if !req.system.is_empty() {
        body["system"] = json!([{ "type": "text", "text": req.system }]);
    }
    if let Some(effort) = &req.effort {
        body["output_config"] = json!({ "effort": effort });
    }
    if FALLBACK_MODELS.contains(&model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// Turns the Messages API's SSE events into [`StreamEvent`]s.
#[derive(Default)]
pub(crate) struct EventMapper {
    usage: Usage,
    stop_reason: Option<String>,
    pub finished: bool,
}

impl EventMapper {
    pub fn handle(&mut self, data: &str, sink: EventSink<'_>) -> Result<(), LlmError> {
        let v: Value = serde_json::from_str(data).map_err(|e| LlmError::Protocol(format!("bad event JSON: {e}")))?;
        match v["type"].as_str().unwrap_or_default() {
            "message_start" => {
                self.merge_usage(&v["message"]["usage"]);
                let model = v["message"]["model"].as_str().unwrap_or_default().to_string();
                sink(StreamEvent::Started { model });
            }
            "content_block_start" => {
                let block = &v["content_block"];
                if block["type"] == "fallback" {
                    sink(StreamEvent::Fallback {
                        from: block["from"]["model"].as_str().unwrap_or_default().to_string(),
                        to: block["to"]["model"].as_str().unwrap_or_default().to_string(),
                    });
                }
            }
            "content_block_delta" => {
                // Thinking deltas (empty by default) and other block types are ignored.
                if v["delta"]["type"] == "text_delta" {
                    let text = v["delta"]["text"].as_str().unwrap_or_default().to_string();
                    sink(StreamEvent::TextDelta { text });
                }
            }
            "message_delta" => {
                if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
                self.merge_usage(&v["usage"]);
            }
            "message_stop" => {
                self.finished = true;
                sink(StreamEvent::Finished { stop_reason: self.stop_reason.clone(), usage: self.usage.clone() });
            }
            "error" => return Err(api_error(None, data)),
            _ => {} // ping, content_block_stop, future event types
        }
        Ok(())
    }

    fn merge_usage(&mut self, u: &Value) {
        let set = |field: &mut u64, key: &str| {
            if let Some(n) = u[key].as_u64() {
                *field = n;
            }
        };
        set(&mut self.usage.input_tokens, "input_tokens");
        set(&mut self.usage.output_tokens, "output_tokens");
        set(&mut self.usage.cache_read_input_tokens, "cache_read_input_tokens");
        set(&mut self.usage.cache_creation_input_tokens, "cache_creation_input_tokens");
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn default_model(&self) -> &'static str {
        DEFAULT_MODEL
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        let key = self.key()?;
        let url = format!("{}/v1/models?limit=100", self.base_url);
        let res = self
            .send(|| self.http.get(&url).header("x-api-key", &key).header("anthropic-version", API_VERSION))
            .await?;
        let body: Value = res.json().await.map_err(|e| LlmError::Protocol(e.to_string()))?;
        Ok(body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let display_name = m["display_name"].as_str().unwrap_or(&id).to_string();
                Some(ModelInfo { id, display_name })
            })
            .collect())
    }

    async fn stream_chat(&self, request: &ChatRequest, sink: EventSink<'_>) -> Result<(), LlmError> {
        let key = self.key()?;
        let url = format!("{}/v1/messages", self.base_url);
        let body = request_body(request);
        let res = self
            .send(|| {
                self.http
                    .post(&url)
                    .header("x-api-key", &key)
                    .header("anthropic-version", API_VERSION)
                    .header("anthropic-beta", FALLBACK_BETA)
                    .json(&body)
            })
            .await?;

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
            return Err(LlmError::Protocol("stream ended before the reply finished".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ChatMessage, Role};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn request(model: Option<&str>) -> ChatRequest {
        ChatRequest {
            model: model.map(str::to_owned),
            system: "You are a reading assistant.".into(),
            messages: vec![ChatMessage { role: Role::User, content: "What is attention?".into() }],
            max_tokens: None,
            effort: None,
        }
    }

    #[test]
    fn body_has_caching_fallbacks_and_system() {
        let body = request_body(&request(None));
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 64_000);
        assert_eq!(body["cache_control"]["type"], "ephemeral");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["system"][0]["text"], "You are a reading assistant.");
        assert_eq!(body["messages"][0], json!({ "role": "user", "content": "What is attention?" }));
        assert!(body.get("thinking").is_none(), "Opus 5.5 runs adaptive thinking by default");
        // Models without server-side fallback don't get the parameter.
        assert!(request_body(&request(Some("claude-haiku-5-5"))).get("fallbacks").is_none());
    }

    const STREAM: &str = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":120,\"cache_read_input_tokens\":4000,\"cache_creation_input_tokens\":0,\"output_tokens\":1}}}\n\n",
        "event: ping\ndata: {\"type\":\"ping\"}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Attention \"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"weighs tokens.\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    /// A one-shot HTTP server that records the request and replies with `response`.
    async fn serve_once(response: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 8192];
            // Read headers, then the body by Content-Length.
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if req.len() >= head_end + 4 + len {
                        break;
                    }
                }
            }
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.shutdown().await.unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });
        (url, handle)
    }

    fn provider(url: &str) -> AnthropicProvider {
        AnthropicProvider::with_base_url(Box::new(|| Some("test-key".into())), url)
    }

    #[tokio::test]
    async fn streams_text_and_usage_over_http() {
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{}",
            STREAM.len(),
            STREAM
        );
        let (url, server) = serve_once(response).await;
        let events = Mutex::new(Vec::new());
        let sink = |e: StreamEvent| events.lock().unwrap().push(e);
        provider(&url).stream_chat(&request(None), &sink).await.unwrap();

        let raw = server.await.unwrap().to_lowercase();
        assert!(raw.starts_with("post /v1/messages"));
        assert!(raw.contains("x-api-key: test-key"));
        assert!(raw.contains("anthropic-version: 2026-10-21"));
        assert!(raw.contains("anthropic-beta: server-side-fallback-2026-07-01"));

        assert_eq!(
            events.into_inner().unwrap(),
            vec![
                StreamEvent::Started { model: "claude-opus-5-5".into() },
                StreamEvent::TextDelta { text: "Attention ".into() },
                StreamEvent::TextDelta { text: "weighs tokens.".into() },
                StreamEvent::Finished {
                    stop_reason: Some("end_turn".into()),
                    usage: Usage {
                        input_tokens: 120,
                        output_tokens: 42,
                        cache_read_input_tokens: 4000,
                        cache_creation_input_tokens: 0,
                    },
                },
            ]
        );
    }

    #[tokio::test]
    async fn reports_api_errors_without_retrying_400() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}"#;
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let (url, _server) = serve_once(response).await;
        let sink = |_e: StreamEvent| {};
        let err = provider(&url).stream_chat(&request(None), &sink).await.unwrap_err();
        match err {
            LlmError::Api { status, kind, message } => {
                assert_eq!(status, Some(400));
                assert_eq!(kind, "invalid_request_error");
                assert_eq!(message, "max_tokens: too large");
            }
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn maps_fallback_and_stream_errors() {
        let events = Mutex::new(Vec::new());
        let sink = |e: StreamEvent| events.lock().unwrap().push(e);
        let mut m = EventMapper::default();
        m.handle(
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-opus-5"}}}"#,
            &sink,
        )
        .unwrap();
        assert_eq!(
            events.into_inner().unwrap(),
            vec![StreamEvent::Fallback { from: "claude-opus-5-5".into(), to: "claude-opus-5".into() }]
        );
        let err = m
            .handle(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, &|_| {})
            .unwrap_err();
        assert!(matches!(err, LlmError::Api { status: None, ref kind, .. } if kind == "overloaded_error"));
    }

    #[test]
    fn missing_key_is_reported() {
        let p = AnthropicProvider::with_base_url(Box::new(|| None), "http://127.0.0.1:1");
        let err = futures_util::FutureExt::now_or_never(p.stream_chat(&request(None), &|_| {})).unwrap().unwrap_err();
        assert!(matches!(err, LlmError::MissingKey(_)));
    }
}
