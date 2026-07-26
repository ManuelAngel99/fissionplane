//! The sandbox data plane: run-to-completion commands and process
//! management, from `src/contracts/dataplane.yaml`.
//!
//! Served at the sandbox's own hostname, off the control plane:
//! available whenever the sandbox is running, even when the control
//! plane is not.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream;
use reqwest::Method;
use serde::Serialize;

use crate::client::AgentTarget;
use crate::dataplane::DataPlane;
use crate::error::Error;
use crate::http::Http;
use crate::models;
use crate::models::{
    CommandResult, Process, ProcessList, ProcessLogs, ProcessStreamEvent, RunCommandRequest,
    StartProcessRequest,
};
use crate::streaming::EventSocket;
use crate::token::TokenSource;

/// A signal deliverable through [`Commands::kill`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Signal {
    /// Graceful termination — the server default when none is sent.
    Term,
    /// Immediate, uncatchable kill.
    Kill,
    /// Interrupt, as from Ctrl-C.
    Int,
    /// Hangup.
    Hup,
}

impl Signal {
    /// The wire name, as used in the `signal` query parameter.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Term => "SIGTERM",
            Self::Kill => "SIGKILL",
            Self::Int => "SIGINT",
            Self::Hup => "SIGHUP",
        }
    }
}

/// Command execution inside one sandbox. Obtained from
/// [`crate::Sandbox::commands`].
///
/// Every request carries the sandbox's capability token as
/// `X-Sandbox-Token`. The token is bound to the sandbox's epoch, so a
/// `Commands` value outlives its token whenever the sandbox is resumed;
/// a rejected token is re-minted through the control plane once and the
/// call is replayed, so the value keeps working across a resume.
///
/// # Examples
///
/// ```no_run
/// use fissionplane::models::RunCommandRequest;
///
/// # async fn demo(sandbox: fissionplane::Sandbox) -> Result<(), fissionplane::Error> {
/// let result = sandbox
///     .commands()?
///     .run(RunCommandRequest {
///         command: "python".to_owned(),
///         args: Some(vec!["-V".to_owned()]),
///         ..Default::default()
///     })
///     .await?;
/// println!("{}", result.stdout);
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct Commands {
    data: DataPlane,
}

impl Commands {
    pub(crate) fn new(
        http: &Http,
        agent: &AgentTarget,
        info: &models::Sandbox,
        credential: TokenSource,
    ) -> Result<Self, Error> {
        Ok(Self {
            data: DataPlane::new(http, agent, info, credential)?,
        })
    }

    /// Start the command inside the sandbox and block until it exits
    /// or its timeout elapses. Output is captured and returned in one
    /// document, truncated at the advertised limit.
    ///
    /// A command that overruns `timeout_seconds` is killed and the
    /// call fails with [`Error::Api`] carrying status 408.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] for a rejected command, including a
    /// timeout, or [`Error::Http`] if transport or decoding fails.
    pub async fn run(&self, request: RunCommandRequest) -> Result<CommandResult, Error> {
        let builder = self.data.request(Method::POST, "/commands").json(&request);
        self.data.send_json(builder).await
    }

    /// Starts a supervised background process and returns a bound handle.
    ///
    /// Set [`StartProcessRequest::pty`] to allocate a pseudo-terminal
    /// before attaching.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the process cannot be started or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn start(&self, request: StartProcessRequest) -> Result<ProcessHandle, Error> {
        let builder = self.data.request(Method::POST, "/processes").json(&request);
        let process = self.data.send_json(builder).await?;
        Ok(ProcessHandle::new(self.clone(), process))
    }

    /// Gets a supervised process and returns a bound handle.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] when the process is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn get(&self, pid: u32) -> Result<ProcessHandle, Error> {
        Ok(ProcessHandle::new(
            self.clone(),
            self.get_process(pid).await?,
        ))
    }

    /// Gets raw metadata for one supervised process.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] when the process is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn get_process(&self, pid: u32) -> Result<Process, Error> {
        let request = self.data.request(Method::GET, &format!("/processes/{pid}"));
        self.data.send_json(request).await
    }

    /// Reads a snapshot of retained process output after `after`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] when the process is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn logs(&self, pid: u32, after: Option<u64>) -> Result<ProcessLogs, Error> {
        let mut request = self
            .data
            .request(Method::GET, &format!("/processes/{pid}/logs"));
        if let Some(after) = after {
            request = request.query(&[("after", after)]);
        }
        self.data.send_json(request).await
    }

    /// Attaches to retained and live process output.
    ///
    /// `after` is the last output sequence already observed.
    ///
    /// A handshake the agent rejects for the token is retried once with
    /// a freshly minted one, so attaching works across a resume.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] if the handshake fails,
    /// [`Error::Protocol`] if the server selects the wrong subprotocol,
    /// or [`Error::WaitTimeout`] if the handshake outlives the client's
    /// request timeout.
    pub async fn attach(&self, pid: u32, after: u64) -> Result<ProcessAttachment, Error> {
        let url = self
            .data
            .base()
            .join(&format!("/processes/{pid}/stream"))
            .map_err(|source| Error::Config(format!("process stream URL: {source}")))?;
        let socket = self
            .data
            .connect(url, &[("after", after.to_string())])
            .await?;
        Ok(ProcessAttachment { socket })
    }

    /// The processes the agent supervises inside the sandbox.
    ///
    /// Returns the current process list.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the agent rejects the request or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn list_processes(&self) -> Result<Vec<Process>, Error> {
        let request = self.data.request(Method::GET, "/processes");
        let list: ProcessList = self.data.send_json(request).await?;
        Ok(list.items)
    }

    /// Send `signal` to the process. `None` means the server default,
    /// SIGTERM.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the process cannot be signalled or
    /// [`Error::Http`] if transport fails.
    pub async fn kill(&self, pid: u32, signal: Option<Signal>) -> Result<(), Error> {
        let mut request = self
            .data
            .request(Method::DELETE, &format!("/processes/{pid}"));
        if let Some(signal) = signal {
            request = request.query(&[("signal", signal.as_str())]);
        }
        self.data.send_no_content(request).await
    }
}

/// Ergonomic operations bound to one supervised process.
#[derive(Clone, Debug)]
pub struct ProcessHandle {
    commands: Commands,
    /// Latest process metadata fetched by this handle.
    pub info: Process,
}

impl ProcessHandle {
    fn new(commands: Commands, info: Process) -> Self {
        Self { commands, info }
    }

    /// Returns the process identifier.
    pub fn pid(&self) -> u32 {
        self.info.pid
    }

    /// Refreshes and returns process metadata.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Commands::get_process`].
    pub async fn refresh(&mut self) -> Result<&Process, Error> {
        self.info = self.commands.get_process(self.info.pid).await?;
        Ok(&self.info)
    }

    /// Reads retained output after `after`.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Commands::logs`].
    pub async fn logs(&self, after: Option<u64>) -> Result<ProcessLogs, Error> {
        self.commands.logs(self.info.pid, after).await
    }

    /// Attaches to retained and live output after `after`.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Commands::attach`].
    pub async fn attach(&self, after: u64) -> Result<ProcessAttachment, Error> {
        self.commands.attach(self.info.pid, after).await
    }

    /// Sends a signal to the process.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Commands::kill`].
    pub async fn kill(&self, signal: Option<Signal>) -> Result<(), Error> {
        self.commands.kill(self.info.pid, signal).await
    }
}

/// An attached process WebSocket with typed events and interactive controls.
#[derive(Debug)]
pub struct ProcessAttachment {
    socket: EventSocket,
}

impl ProcessAttachment {
    /// Writes UTF-8 text to process stdin.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when sending fails.
    pub async fn send_input(&mut self, data: impl Into<String>) -> Result<(), Error> {
        self.socket
            .send(&ProcessClientMessage::Input { data: data.into() })
            .await
    }

    /// Closes process stdin without closing the output stream.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when sending fails.
    pub async fn close_stdin(&mut self) -> Result<(), Error> {
        self.socket.send(&ProcessClientMessage::CloseStdin).await
    }

    /// Changes the dimensions of an attached pseudo-terminal.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when sending fails.
    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Error> {
        self.socket
            .send(&ProcessClientMessage::Resize { cols, rows })
            .await
    }

    /// Delivers a signal through the attached stream.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when sending fails.
    pub async fn signal(&mut self, signal: Signal) -> Result<(), Error> {
        self.socket
            .send(&ProcessClientMessage::Signal {
                signal: signal.as_str(),
            })
            .await
    }

    /// Closes the WebSocket.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when closing fails.
    pub async fn close(&mut self) -> Result<(), Error> {
        self.socket.close().await
    }
}

impl Stream for ProcessAttachment {
    type Item = Result<ProcessStreamEvent, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().socket.poll_event(
            cx,
            &["stdout", "stderr", "exit", "gap"],
            "process stream",
            valid_process_event,
        )
    }
}

fn valid_process_event(event: &ProcessStreamEvent) -> bool {
    match event {
        ProcessStreamEvent::Stdout { sequence, .. }
        | ProcessStreamEvent::Stderr { sequence, .. }
        | ProcessStreamEvent::Exit { sequence, .. } => *sequence > 0,
        ProcessStreamEvent::Gap {
            from_sequence,
            to_sequence,
        } => *from_sequence > 0 && *to_sequence > 0,
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ProcessClientMessage<'a> {
    Input { data: String },
    CloseStdin,
    Resize { cols: u16, rows: u16 },
    Signal { signal: &'a str },
}
