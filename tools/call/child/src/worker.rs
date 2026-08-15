use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{timeout, Duration};

use crate::log;

pub struct LineWorker {
    label: &'static str,
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl LineWorker {
    async fn spawn(
        label: &'static str,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<(Self, f64)> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("spawn {label} worker via {}", program.display()))?;
        let stdin = child.stdin.take().context("worker stdin")?;
        let stdout = child.stdout.take().context("worker stdout")?;
        let stderr = child.stderr.take().context("worker stderr")?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log(format!("{label}-worker: {line}"));
            }
        });
        let mut worker = Self {
            label,
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
        };
        let ready = timeout(Duration::from_secs(60), worker.next_json())
            .await
            .with_context(|| format!("{label} worker not ready after 60000ms"))??;
        if ready.get("ready").and_then(Value::as_bool) != Some(true) {
            bail!("{label} worker sent invalid ready frame: {ready}");
        }
        Ok((
            worker,
            ready.get("load_s").and_then(Value::as_f64).unwrap_or(0.0),
        ))
    }

    pub async fn start_kokoro(repo_root: &Path) -> Result<(Self, f64)> {
        let home = std::env::var_os("HOME").context("HOME is unset")?;
        let python = PathBuf::from(home).join(".fig/tts/venv/bin/python");
        let script = repo_root.join("tools/call/kokoro_worker.py");
        Self::spawn(
            "kokoro",
            &python,
            &[script.to_string_lossy().to_string()],
            &[],
        )
        .await
    }

    pub async fn start_whisper(repo_root: &Path) -> Result<(Self, f64)> {
        let cli = std::env::var("MLX_WHISPER_BIN")
            .unwrap_or_else(|_| "/opt/homebrew/bin/mlx_whisper".to_owned());
        let python = if let Ok(override_python) = std::env::var("CALL_STT_PYTHON") {
            PathBuf::from(override_python)
        } else {
            shebang_python(Path::new(&cli)).unwrap_or_else(|| PathBuf::from("python3"))
        };
        let script = repo_root.join("tools/call/whisper_worker.py");
        let model = stt_model();
        let language = std::env::var("STT_LANGUAGE").unwrap_or_else(|_| "en".to_owned());
        let mut env = Vec::new();
        if std::env::var("STT_ALLOW_DOWNLOAD").as_deref() != Ok("1") {
            env.push(("HF_HUB_OFFLINE".to_owned(), "1".to_owned()));
        }
        Self::spawn(
            "whisper",
            &python,
            &[script.to_string_lossy().to_string(), model, language],
            &env,
        )
        .await
    }

    async fn next_json(&mut self) -> Result<Value> {
        while let Some(line) = self.lines.next_line().await? {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                return Ok(value);
            }
        }
        bail!("{} worker stdout closed", self.label)
    }

    async fn request(&mut self, mut request: Value, timeout_ms: u64) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        request["id"] = json!(id);
        self.stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .with_context(|| format!("write {} request", self.label))?;
        self.stdin.flush().await?;
        let reply = timeout(Duration::from_millis(timeout_ms), async {
            loop {
                let reply = self.next_json().await?;
                if reply.get("id").and_then(Value::as_u64) == Some(id) {
                    return Ok::<Value, anyhow::Error>(reply);
                }
            }
        })
        .await
        .with_context(|| format!("{} request timed out ({timeout_ms}ms)", self.label))??;
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!(
                "{}",
                reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("worker request failed")
            );
        }
        Ok(reply)
    }

    pub async fn render(&mut self, text: &str) -> Result<Vec<u8>> {
        let voice = std::env::var("CALL_TTS_VOICE").unwrap_or_else(|_| "am_michael".to_owned());
        let speed = std::env::var("CALL_TTS_SPEED")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(1.0);
        let reply = self
            .request(
                json!({ "text": text, "voice": voice, "speed": speed }),
                30_000,
            )
            .await?;
        let encoded = reply
            .get("b64")
            .and_then(Value::as_str)
            .context("kokoro reply missing b64")?;
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("decode kokoro pcm")
    }

    pub async fn transcribe(&mut self, path: &Path) -> Result<String> {
        let reply = self
            .request(json!({ "path": path.to_string_lossy() }), 30_000)
            .await?;
        Ok(reply
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned())
    }

    pub async fn stop(&mut self) {
        let _ = self.stdin.shutdown().await;
        if timeout(Duration::from_secs(1), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

fn shebang_python(cli: &Path) -> Option<PathBuf> {
    let first = std::fs::read_to_string(cli)
        .ok()?
        .lines()
        .next()?
        .to_owned();
    let path = first.strip_prefix("#!")?.trim().split_whitespace().next()?;
    let path = PathBuf::from(path);
    path.exists().then_some(path)
}

pub fn stt_model() -> String {
    std::env::var("CALL_STT_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("STT_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "mlx-community/whisper-small-mlx".to_owned())
}

pub async fn transcribe_one_shot(wav: &Path) -> Result<(String, u128)> {
    let cli = std::env::var("MLX_WHISPER_BIN")
        .unwrap_or_else(|_| "/opt/homebrew/bin/mlx_whisper".to_owned());
    let scratch = std::env::temp_dir().join(format!(
        "fig-stt-rs-{}-{}",
        std::process::id(),
        crate::epoch_ms()
    ));
    std::fs::create_dir_all(&scratch)?;
    let started = std::time::Instant::now();
    let mut command = Command::new(cli);
    command
        .arg("--model")
        .arg(stt_model())
        .arg("--output-dir")
        .arg(&scratch)
        .arg("--output-format")
        .arg("txt")
        .arg("--output-name")
        .arg("out")
        .arg("--verbose")
        .arg("False");
    if let Ok(language) = std::env::var("STT_LANGUAGE") {
        if !language.trim().is_empty() {
            command.arg("--language").arg(language);
        }
    } else {
        command.arg("--language").arg("en");
    }
    if std::env::var("STT_ALLOW_DOWNLOAD").as_deref() != Ok("1") {
        command.env("HF_HUB_OFFLINE", "1");
    }
    let output = command.arg(wav).output().await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!(
            "one-shot whisper failed: {}",
            detail.lines().last().unwrap_or("unknown error")
        );
    }
    let text = std::fs::read_to_string(scratch.join("out.txt"))
        .unwrap_or_default()
        .trim()
        .to_owned();
    let _ = std::fs::remove_dir_all(scratch);
    Ok((text, started.elapsed().as_millis()))
}
