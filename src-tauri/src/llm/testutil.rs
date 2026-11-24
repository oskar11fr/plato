//! A tiny HTTP server for tests: each request is answered by a handler.

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    /// Path including the query string.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn form(&self) -> Vec<(String, String)> {
        url_decode_pairs(&self.body)
    }
}

pub fn url_decode_pairs(s: &str) -> Vec<(String, String)> {
    reqwest::Url::parse(&format!("http://x/?{s}")).unwrap().query_pairs().into_owned().collect()
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl Response {
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self { status, content_type: "application/json", body: body.into() }
    }
    pub fn sse(body: impl Into<String>) -> Self {
        Self { status: 200, content_type: "text/event-stream", body: body.into() }
    }
}

pub struct MockServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
}

/// Serve requests until the test ends; every request is recorded.
pub async fn serve<F>(handler: F) -> MockServer
where
    F: Fn(&Request) -> Response + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let handler = Arc::new(handler);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let handler = handler.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let Some(req) = read_request(&mut sock).await else { return };
                log.lock().unwrap().push(req.clone());
                let res = handler(&req);
                let reason = if res.status < 400 { "OK" } else { "Error" };
                let head = format!(
                    "HTTP/1.1 {} {reason}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    res.status,
                    res.content_type,
                    res.body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(res.body.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    MockServer { url, requests }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).into_owned();
        let Some(head_end) = text.find("\r\n\r\n") else { continue };
        let mut lines = text[..head_end].lines();
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?.to_string();
        let target = first.next()?.to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':').map(|(n, v)| (n.trim().to_string(), v.trim().to_string())))
            .collect();
        let len = headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);
        if buf.len() >= head_end + 4 + len {
            let body = String::from_utf8_lossy(&buf[head_end + 4..head_end + 4 + len]).into_owned();
            return Some(Request { method, target, headers, body });
        }
    }
}
