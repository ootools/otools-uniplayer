use std::{process::Stdio, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;

pub const FORMAT_WHITELIST: &str = "mov,matroska,webm,avi,mpeg,mpegts,mp3,aac,flac,wav,ogg";

pub fn local_command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The host owns the root service's process group (or Windows Job).
    // Media tools must inherit that containment so a forced root-group kill
    // also reaches them when the service cannot run its shutdown handler.
    command
}

pub async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = child.start_kill();
        }
        if tokio::time::timeout(Duration::from_millis(800), child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

pub async fn capture(
    mut command: Command,
    limit: usize,
    timeout: Duration,
    shutdown: &CancellationToken,
) -> Result<Vec<u8>, String> {
    if shutdown.is_cancelled() {
        return Err("service is shutting down".into());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "media tool cannot be started".to_owned())?;
    let stdout = child.stdout.take().ok_or("media tool output unavailable")?;
    let result = {
        let work = async {
            let mut output = Vec::new();
            stdout
                .take(limit as u64 + 1)
                .read_to_end(&mut output)
                .await
                .map_err(|_| "media tool failed".to_owned())?;
            if output.len() > limit {
                return Err("media tool output exceeds limit".into());
            }
            let status = child
                .wait()
                .await
                .map_err(|_| "media tool failed".to_owned())?;
            if !status.success() {
                return Err("media tool failed".into());
            }
            Ok(output)
        };
        tokio::select! {
            result = work => result,
            _ = tokio::time::sleep(timeout) => Err("media tool timed out".into()),
            _ = shutdown.cancelled() => Err("service is shutting down".into()),
        }
    };
    if result.is_err() {
        terminate(&mut child).await;
    }
    result
}
