//! Minimal Server-Sent Events parser for streamed HTTP responses.

#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// Feed bytes; returns every event completed by them. Chunks may split
    /// lines (and UTF-8 sequences) anywhere.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel;
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            let line = String::from_utf8_lossy(line).into_owned();
            start = end + 1;

            if line.is_empty() {
                if !self.data.is_empty() || self.event.is_some() {
                    out.push(SseEvent { event: self.event.take(), data: self.data.join("\n") });
                    self.data.clear();
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // comment / keep-alive
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => self.event = Some(value.to_string()),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        self.buf.drain(..start);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_chunks() {
        let mut p = SseParser::default();
        let mut events = p.push(b"event: message_start\ndata: {\"a\":");
        assert!(events.is_empty());
        events.extend(p.push(b"1}\n\nevent: ping\r\ndata: {}\r\n\r\n"));
        assert_eq!(
            events,
            vec![
                SseEvent { event: Some("message_start".into()), data: "{\"a\":1}".into() },
                SseEvent { event: Some("ping".into()), data: "{}".into() },
            ]
        );
    }

    #[test]
    fn joins_multiline_data_and_skips_comments() {
        let mut p = SseParser::default();
        let events = p.push(b": keep-alive\ndata: one\ndata: two\n\n");
        assert_eq!(events, vec![SseEvent { event: None, data: "one\ntwo".into() }]);
    }

    #[test]
    fn handles_utf8_split_mid_character() {
        let mut p = SseParser::default();
        let text = "data: Łukasz\n\n".as_bytes();
        let (a, b) = text.split_at(7); // inside the two-byte 'Ł'
        assert!(p.push(a).is_empty());
        assert_eq!(p.push(b)[0].data, "Łukasz");
    }
}
