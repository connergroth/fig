use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

#[derive(Clone)]
pub struct BridgeClient {
    socket_path: PathBuf,
    token: String,
}

impl BridgeClient {
    pub async fn connect(socket_path: PathBuf, token: String) -> Result<Self> {
        let stream = UnixStream::connect(&socket_path)
            .await
            .with_context(|| format!("connect bridge {}", socket_path.display()))?;
        drop(stream);
        Ok(Self { socket_path, token })
    }

    async fn open_request(&self, id: u64, method: &str, fields: Value) -> Result<UnixStream> {
        let mut stream = UnixStream::connect(&self.socket_path).await?;
        let mut request = json!({
            "id": id,
            "token": self.token.clone(),
            "method": method,
        });
        if let (Some(dst), Some(src)) = (request.as_object_mut(), fields.as_object()) {
            dst.extend(src.clone());
        }
        stream.write_all(format!("{request}\n").as_bytes()).await?;
        stream.flush().await?;
        Ok(stream)
    }

    pub async fn ask_stream(
        &self,
        question: String,
        delta_tx: mpsc::UnboundedSender<String>,
        interrupted: Option<String>,
    ) -> Result<String> {
        let id = crate::epoch_ms() as u64;
        // `spoken`: this question is HIS OWN WORDS, verbatim — every `on_question` is
        // either the utterance just transcribed or folds joined to it. The lane writes
        // that line into the conversation transcript when the turn starts, never before,
        // because the same transcript seeds the turn's prompt (see pending.rs).
        //
        // `interrupted`: they cut the last reply off, and this is what they had heard of it.
        // Prompt-only — the lane annotates the MODEL INPUT with it and writes nothing
        // (see interrupt.rs).
        let mut fields = json!({ "question": question, "spoken": true });
        if let Some(heard) = interrupted {
            fields["interrupted"] = json!(heard);
        }
        let stream = self.open_request(id, "ask_stream", fields).await?;
        let mut lines = BufReader::new(stream).lines();
        loop {
            let line = timeout(Duration::from_secs(150), lines.next_line())
                .await
                .context("bridge ask_stream idle for 150000ms")??
                .context("bridge closed during ask_stream")?;
            let frame: Value = serde_json::from_str(&line)?;
            if frame.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if frame.get("ok").and_then(Value::as_bool) != Some(true) {
                bail!(
                    "{}",
                    frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("ask_stream failed")
                );
            }
            if frame.get("done").and_then(Value::as_bool) == Some(true)
                || frame.get("delta").is_none()
            {
                return Ok(frame
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned());
            }
            if let Some(delta) = frame.get("delta").and_then(Value::as_str) {
                if !delta.is_empty() {
                    let _ = delta_tx.send(delta.to_owned());
                }
            }
        }
    }

    pub async fn notify(&self, method: &str, fields: Value) -> Result<()> {
        let id = crate::epoch_ms() as u64;
        let stream = self.open_request(id, method, fields).await?;
        let mut lines = BufReader::new(stream).lines();
        let line = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .context("bridge notify timed out")??
            .context("bridge closed before notify reply")?;
        let frame: Value = serde_json::from_str(&line)?;
        if frame.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!(
                "{}",
                frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("bridge notify failed")
            );
        }
        Ok(())
    }
}
