use regex::Regex;

const SOFT_CLAUSE_CHARS: usize = 40;
/// Shortest thing worth sending to kokoro on its own. Below this a fragment rides along
/// with the clause after it, so "Ha!" or "Yeah." is spoken as the head of the next
/// sentence instead of a tiny clip with its own render latency and its own pause either
/// side. Hermes' `SentenceChunker(min_len=20)`.
const MIN_CLAUSE_CHARS: usize = 20;

/// One place the buffer can be cut. `hard` marks fig's own `[[split]]`, which is never
/// overruled by the minimum-length rule.
struct Boundary {
    end: usize,
    resume: usize,
    hard: bool,
}

pub struct ClauseSplitter {
    buffer: String,
    said_link_line: bool,
    pub dropped_urls: Vec<String>,
    url_re: Regex,
    split_re: Regex,
}

impl ClauseSplitter {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            said_link_line: false,
            dropped_urls: Vec::new(),
            url_re: Regex::new(r#"(?i)(?:https?://|www\.)[^\s)\]}>"']+"#).unwrap(),
            split_re: Regex::new(r"(?i)\[\[\s*split\s*\]\]").unwrap(),
        }
    }

    pub fn push(&mut self, delta: &str) -> Vec<String> {
        self.buffer.push_str(delta);
        let mut out = Vec::new();
        let mut from = 0usize;
        while let Some(Boundary { end, resume, hard }) = self.boundary(from) {
            // Too short to stand on its own: skip this boundary and keep looking, which
            // merges the fragment into whatever clause the NEXT boundary closes.
            // `[[split]]` is exempt — it is fig writing "these are two separate things",
            // not a guess at where a sentence ended.
            if !hard && self.buffer[..end].trim().chars().count() < MIN_CLAUSE_CHARS {
                from = resume;
                continue;
            }
            let raw = self.buffer[..end].to_owned();
            self.buffer = self.buffer[resume..].to_owned();
            from = 0;
            if let Some(clause) = self.finish(&raw) {
                out.push(clause);
            }
        }
        out
    }

    pub fn flush(&mut self) -> Vec<String> {
        let raw = self.split_re.replace_all(&self.buffer, " ").to_string();
        self.buffer.clear();
        self.finish(&raw).into_iter().collect()
    }

    /// How much text is sitting in the buffer with no boundary in sight — what the idle
    /// producer flush in main.rs decides on.
    pub fn buffered_chars(&self) -> usize {
        self.buffer.trim().chars().count()
    }

    fn boundary(&self, from: usize) -> Option<Boundary> {
        if from >= self.buffer.len() {
            return None;
        }
        let hard = self
            .split_re
            .find_at(&self.buffer, from)
            .map(|found| Boundary {
                end: found.start(),
                resume: found.end(),
                hard: true,
            });
        let bytes = self.buffer.as_bytes();
        let mut ender = None;
        for (offset, ch) in self.buffer[from..].char_indices() {
            let index = from + offset;
            if ch == '\n' {
                ender = Some(Boundary { end: index, resume: index + 1, hard: false });
                break;
            }
            if !matches!(ch, '.' | '!' | '?' | '…') {
                continue;
            }
            let next = self.buffer[index + ch.len_utf8()..].chars().next();
            if next.is_some_and(char::is_whitespace) && !self.inside_url(index) {
                let at = index + ch.len_utf8();
                ender = Some(Boundary { end: at, resume: at, hard: false });
                break;
            }
        }
        match (hard, ender) {
            (Some(a), Some(b)) => Some(if b.end < a.end { b } else { a }),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) if bytes.len() > SOFT_CLAUSE_CHARS => {
                for index in from.max(8)..bytes.len().saturating_sub(1) {
                    let ch = bytes[index];
                    let spaced = bytes[index + 1].is_ascii_whitespace();
                    let boundary = (ch == b',' && spaced)
                        || (ch == b'-'
                            && spaced
                            && bytes[index.saturating_sub(1)].is_ascii_whitespace());
                    if boundary && !self.inside_url(index) {
                        return Some(Boundary { end: index + 1, resume: index + 1, hard: false });
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn inside_url(&self, index: usize) -> bool {
        self.url_re
            .find_iter(&self.buffer)
            .any(|found| index >= found.start() && index < found.end())
    }

    fn finish(&mut self, raw: &str) -> Option<String> {
        let mut had_url = false;
        let mut no_urls = String::with_capacity(raw.len());
        let mut cursor = 0;
        for found in self.url_re.find_iter(raw) {
            no_urls.push_str(&raw[cursor..found.start()]);
            no_urls.push(' ');
            had_url = true;
            self.dropped_urls.push(
                found
                    .as_str()
                    .trim_end_matches(|ch| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?'))
                    .to_owned(),
            );
            cursor = found.end();
        }
        no_urls.push_str(&raw[cursor..]);
        let mut text = clean_for_speech(&no_urls);
        if had_url && !self.said_link_line {
            self.said_link_line = true;
            text = if text.is_empty() {
                "sent you the link".to_owned()
            } else {
                format!("{text} — sent you the link")
            };
        }
        if !text.chars().any(|c| c.is_ascii_alphanumeric()) {
            None
        } else {
            Some(text)
        }
    }
}

fn clean_for_speech(input: &str) -> String {
    let code = Regex::new(r"(?s)```.*?```")
        .unwrap()
        .replace_all(input, " ");
    let inline = Regex::new(r"`([^`]*)`").unwrap().replace_all(&code, "$1");
    let links = Regex::new(r"!?\[([^\]]*)\]\([^)]*\)")
        .unwrap()
        .replace_all(&inline, "$1");
    let markdown = links
        .replace("**", "")
        .replace("__", "")
        .replace("[[split]]", " ");
    markdown
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c.is_whitespace() || ",;:—–-".contains(c))
        .to_owned()
}

impl Default for ClauseSplitter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_complete_sentences() {
        let mut splitter = ClauseSplitter::new();
        assert!(splitter.push("that's the whole answer.").is_empty());
        assert_eq!(
            splitter.push(" and here's the next thought"),
            vec!["that's the whole answer."]
        );
        assert_eq!(splitter.flush(), vec!["and here's the next thought"]);
    }

    #[test]
    fn a_fragment_rides_along_with_the_clause_after_it() {
        // "Ha!" as its own kokoro clip is a tic, not speech — it waits for the sentence
        // that follows and is spoken as one breath with it.
        let mut splitter = ClauseSplitter::new();
        assert!(splitter.push("Ha! ").is_empty(), "a 3-char clip was spoken alone");
        assert_eq!(
            splitter.push("that's exactly the thing i was after. "),
            vec!["Ha! that's exactly the thing i was after."]
        );
    }

    #[test]
    fn fig_s_own_split_marker_still_breaks_wherever_he_put_it() {
        // The minimum length is a guess at sentence ends; `[[split]]` is not a guess.
        let mut splitter = ClauseSplitter::new();
        assert_eq!(splitter.push("ok. [[split]] "), vec!["ok."]);
    }

    #[test]
    fn buffered_chars_sees_what_no_boundary_has_closed() {
        let mut splitter = ClauseSplitter::new();
        assert!(splitter.push("still going and going and").is_empty());
        assert_eq!(splitter.buffered_chars(), "still going and going and".len());
        splitter.flush();
        assert_eq!(splitter.buffered_chars(), 0);
    }

    #[test]
    fn drops_urls_but_records_them() {
        let mut splitter = ClauseSplitter::new();
        assert_eq!(
            splitter.push("see https://example.com now. "),
            vec!["see now. — sent you the link"]
        );
        assert_eq!(splitter.dropped_urls, vec!["https://example.com"]);
    }
}
