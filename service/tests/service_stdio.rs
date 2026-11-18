use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Running {
    child: Child,
    output: mpsc::Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn media_tool(name: &str) -> String {
    let variable = if name == "ffmpeg" {
        "FFMPEG_PATH"
    } else {
        "FFPROBE_PATH"
    };
    std::env::var(variable).unwrap_or_else(|_| format!("/opt/homebrew/bin/{name}"))
}

fn launch(init: Value) -> Running {
    let executable = std::env::var_os("CARGO_BIN_EXE_otools-media-service")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/debug/otools-media-service")
        });
    assert!(
        executable.is_file(),
        "the --stdio service executable must be built, not only the library"
    );
    let mut command = Command::new(executable);
    command
        .arg("--stdio")
        .env("FFMPEG_PATH", media_tool("ffmpeg"))
        .env("FFPROBE_PATH", media_tool("ffprobe"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Only the root gets a new group, exactly as the host launches it.
        // Force-kill tests must never signal the cargo test process group.
        command.process_group(0);
    }
    let mut child = command.spawn().unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{init}").unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    Running {
        child,
        output: rx,
        reader: Some(reader),
    }
}

fn wait_exit(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "service exit: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "service must exit promptly");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn raw_http(port: u16, method: &str, path: &str, body: &str) -> String {
    use std::io::Read;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(25)))
        .unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://localhost:6574\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", "b".repeat(64), body.len()).unwrap();
    let mut output = String::new();
    stream.read_to_string(&mut output).unwrap();
    output
}

fn worker_pids(parent: u32) -> Vec<u32> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let ppid: u32 = parts.next()?.parse().ok()?;
            let executable = parts.next()?;
            (ppid == parent && executable.ends_with("ffmpeg")).then_some(pid)
        })
        .collect()
}

fn synth() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("long.mp4");
    let output = Command::new(media_tool("ffmpeg"))
        .args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-t",
            "90",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "48",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
        ])
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fixture failure: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    (dir, file)
}

#[test]
fn stdio_handshake_starts_real_loopback_http_and_eof_or_sigterm_reaps_active_worker() {
    let (_dir, file) = synth();
    for sigterm in [false, true] {
        let mut service = launch(
            json!({"type": "init", "token": "b".repeat(64), "origin": "http://localhost:6574"}),
        );
        let line = service
            .output
            .recv_timeout(Duration::from_secs(6))
            .expect("ready JSON");
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["event"], "ready");
        assert_eq!(ready["protocol"], 1);
        assert!(!line.contains(&"b".repeat(64)));
        let port = ready["port"].as_u64().unwrap() as u16;
        assert!(port > 0);
        let response = raw_http(
            port,
            "POST",
            "/api/open",
            &json!({"path": file}).to_string(),
        );
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "real HTTP open: {response}"
        );
        let workers = worker_pids(service.child.id());
        assert_eq!(workers.len(), 1);
        if sigterm {
            unsafe {
                libc::kill(service.child.id() as i32, libc::SIGTERM);
            }
        } else {
            drop(service.child.stdin.take());
        }
        wait_exit(&mut service.child);
        for pid in workers {
            assert_eq!(
                unsafe { libc::kill(pid as i32, 0) },
                -1,
                "child FFmpeg survived service exit"
            );
        }
        assert!(
            service
                .output
                .try_iter()
                .all(|line| !line.contains(&"b".repeat(64))
                    && !line.contains(file.to_str().unwrap()))
        );
    }
}

#[test]
fn hangup_and_sigterm_with_incomplete_http_body_exit_and_reap_the_worker() {
    let (_dir, file) = synth();
    for signal in [libc::SIGHUP, libc::SIGTERM] {
        let mut service = launch(
            json!({"type": "init", "token": "b".repeat(64), "origin": "http://localhost:6574"}),
        );
        let ready: Value =
            serde_json::from_str(&service.output.recv_timeout(Duration::from_secs(6)).unwrap())
                .unwrap();
        let port = ready["port"].as_u64().unwrap() as u16;
        assert!(
            raw_http(
                port,
                "POST",
                "/api/open",
                &json!({"path": file}).to_string()
            )
            .starts_with("HTTP/1.1 200")
        );
        let workers = worker_pids(service.child.id());
        assert_eq!(workers.len(), 1);
        let mut slow = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(slow, "POST /api/seek HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://localhost:6574\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{{", "b".repeat(64)).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        unsafe {
            libc::kill(service.child.id() as i32, signal);
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        while service.child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                for pid in &workers {
                    unsafe {
                        libc::kill(*pid as i32, libc::SIGKILL);
                    }
                }
                panic!("slow HTTP body must not prevent signal exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        for pid in workers {
            let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
            if alive {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            assert!(!alive, "signal exit orphaned an FFmpeg worker");
        }
        drop(slow);
    }
}

#[cfg(unix)]
#[test]
fn host_force_kill_root_group_cannot_leave_an_ffmpeg_worker_outside_the_managed_group() {
    use std::os::unix::process::ExitStatusExt;
    let (_dir, file) = synth();
    let mut service =
        launch(json!({"type": "init", "token": "b".repeat(64), "origin": "http://localhost:6574"}));
    let ready: Value =
        serde_json::from_str(&service.output.recv_timeout(Duration::from_secs(6)).unwrap())
            .unwrap();
    let port = ready["port"].as_u64().unwrap() as u16;
    assert!(
        raw_http(
            port,
            "POST",
            "/api/open",
            &json!({"path": file}).to_string()
        )
        .starts_with("HTTP/1.1 200")
    );
    let root = service.child.id() as i32;
    let group = unsafe { libc::getpgid(root) };
    assert_eq!(
        group, root,
        "the test must isolate exactly the host root's group"
    );
    assert_ne!(
        group,
        unsafe { libc::getpgrp() },
        "never signal cargo's group"
    );
    let workers = worker_pids(service.child.id());
    assert_eq!(workers.len(), 1);
    let worker_groups: Vec<_> = workers
        .iter()
        .map(|pid| unsafe { libc::getpgid(*pid as i32) })
        .collect();
    assert_eq!(unsafe { libc::kill(-group, libc::SIGKILL) }, 0);
    let exit = service.child.wait().unwrap();
    assert_eq!(
        exit.signal(),
        Some(libc::SIGKILL),
        "no service shutdown handler may be needed for host force kill"
    );
    let deadline = Instant::now() + Duration::from_secs(6);
    let remaining = loop {
        let remaining: Vec<_> = workers
            .iter()
            .copied()
            .filter(|pid| unsafe { libc::kill(*pid as i32, 0) } == 0)
            .collect();
        if remaining.is_empty() || Instant::now() >= deadline {
            break remaining;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // RED runs still clean up the escaped worker explicitly, never its group.
    for pid in &remaining {
        unsafe {
            libc::kill(*pid as i32, libc::SIGKILL);
        }
    }
    assert!(
        worker_groups
            .iter()
            .all(|child_group| *child_group == group)
            && remaining.is_empty(),
        "host root-group SIGKILL must cover every worker: root PGID {group}, worker PGIDs {worker_groups:?}, residual PIDs {remaining:?}"
    );
    assert_eq!(
        unsafe { libc::kill(-group, 0) },
        -1,
        "the managed group must be gone after host force kill"
    );
}

#[test]
fn stdio_rejects_bad_init_without_echoing_the_secret() {
    let mut service =
        launch(json!({"type": "init", "token": "b".repeat(65), "origin": "http://localhost:6574"}));
    drop(service.child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(6);
    while service.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "invalid init must fail promptly");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !service
            .output
            .try_iter()
            .any(|line| line.contains(&"b".repeat(65)) || line.contains("\"event\":\"ready\""))
    );
}
