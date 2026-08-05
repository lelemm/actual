use std::{
    net::SocketAddr,
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use tokio::sync::oneshot;

use crate::{app, load_config::Config};

const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

struct Server {
    handle: u64,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    status: Arc<Mutex<Status>>,
}

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

fn server() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

pub fn start(data_dir: &Path, port: u16) -> Result<u64, String> {
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }

    let mut slot = server().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(existing) = slot.as_ref()
        && !matches!(
            status_value(&existing.status),
            Status::Stopped | Status::Failed
        )
    {
        return Ok(existing.handle);
    }

    if let Some(mut previous) = slot.take()
        && let Some(thread) = previous.thread.take()
    {
        let _ = thread.join();
    }

    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let status = Arc::new(Mutex::new(Status::Starting));
    let thread_status = Arc::clone(&status);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
    let config = embedded_config(data_dir, port);
    let thread = thread::Builder::new()
        .name("actual-sync-server".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    set_status(&thread_status, Status::Failed);
                    send_ready(&ready_tx, Err(error.to_string()));
                    return;
                }
            };
            let notify_status = Arc::clone(&thread_status);
            let notify_ready = Arc::clone(&ready_tx);
            let result = runtime.block_on(app::run_with_ready_and_shutdown(
                config,
                move |_| {
                    set_status(&notify_status, Status::Running);
                    send_ready(&notify_ready, Ok(()));
                    Ok(())
                },
                async move {
                    let _ = shutdown_rx.await;
                },
            ));
            let was_stopping = status_value(&thread_status) == Status::Stopping;
            set_status(
                &thread_status,
                if result.is_ok() || was_stopping {
                    Status::Stopped
                } else {
                    Status::Failed
                },
            );
            if let Err(error) = result {
                send_ready(&ready_tx, Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;

    match ready_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => {
            *slot = Some(Server {
                handle,
                shutdown: Some(shutdown_tx),
                thread: Some(thread),
                status,
            });
            Ok(handle)
        }
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(error) => {
            let _ = shutdown_tx.send(());
            let _ = thread.join();
            Err(format!("sync server did not start: {error}"))
        }
    }
}

pub fn stop(handle: u64) -> Result<(), String> {
    let (shutdown, thread, status) = {
        let mut slot = server().lock().unwrap_or_else(|error| error.into_inner());
        let current = slot
            .as_mut()
            .filter(|server| server.handle == handle)
            .ok_or_else(|| "unknown sync server handle".to_owned())?;
        if matches!(status_value(&current.status), Status::Stopped) {
            return Ok(());
        }
        set_status(&current.status, Status::Stopping);
        (
            current.shutdown.take(),
            current.thread.take(),
            Arc::clone(&current.status),
        )
    };
    if let Some(shutdown) = shutdown {
        let _ = shutdown.send(());
    }
    if let Some(thread) = thread {
        thread
            .join()
            .map_err(|_| "sync server thread panicked".to_owned())?;
    }
    set_status(&status, Status::Stopped);
    Ok(())
}

pub fn status(handle: u64) -> Result<Status, String> {
    let slot = server().lock().unwrap_or_else(|error| error.into_inner());
    let current = slot
        .as_ref()
        .filter(|server| server.handle == handle)
        .ok_or_else(|| "unknown sync server handle".to_owned())?;
    Ok(status_value(&current.status))
}

fn embedded_config(data_dir: &Path, port: u16) -> Config {
    let mut config = Config::default();
    config.environment = "production".into();
    config.mode = "production".into();
    config.data_dir = data_dir.to_owned();
    config.server_files = data_dir.join("server-files");
    config.user_files = data_dir.join("user-files");
    config.port = port;
    config.hostname = "127.0.0.1".into();
    config.address = SocketAddr::from(([127, 0, 0, 1], port));
    config
}

fn status_value(status: &Mutex<Status>) -> Status {
    *status.lock().unwrap_or_else(|error| error.into_inner())
}

fn set_status(status: &Mutex<Status>, value: Status) {
    *status.lock().unwrap_or_else(|error| error.into_inner()) = value;
}

fn send_ready(
    sender: &Mutex<Option<mpsc::SyncSender<Result<(), String>>>>,
    value: Result<(), String>,
) {
    if let Some(sender) = sender
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        let _ = sender.send(value);
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, net::TcpListener, time::SystemTime};

    use super::*;

    #[test]
    fn starts_reports_and_stops_a_persistent_server() {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let root = std::env::temp_dir().join(format!(
            "actual-embedded-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let handle = start(&root, port).unwrap();
        assert_eq!(status(handle).unwrap(), Status::Running);
        assert!(root.join("server-files/account.sqlite").is_file());
        stop(handle).unwrap();
        stop(handle).unwrap();
        assert_eq!(status(handle).unwrap(), Status::Stopped);

        fs::remove_dir_all(root).unwrap();
    }
}
