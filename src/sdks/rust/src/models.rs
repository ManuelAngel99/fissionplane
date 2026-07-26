//! Serde models mirroring `src/contracts/openapi.yaml` (control plane) and
//! `src/contracts/dataplane.yaml` (data plane).
//!
//! This crate is hand-written against those documents, so the mapping
//! is deliberately mechanical: every field keeps the contract's
//! snake_case name, optional fields are [`Option`], and optional
//! request fields are skipped when unset so the wire body matches what
//! a curl of the contract would send.
//!
//! Timestamps (`created_at`, `deadline`, `expires_at`, ...) are RFC 3339
//! strings and stay [`String`] here: which time crate to parse them
//! with is the caller's choice, not a dependency this SDK imposes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The tenant-visible sandbox states — exactly these four.
///
/// Transitional states are internal: a pausing sandbox reads as
/// `running`, a resuming one as `paused`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxState {
    /// The sandbox serves traffic.
    Running,
    /// The sandbox is snapshotted; resume restores it under a new epoch.
    Paused,
    /// Terminal: the sandbox was deleted or its lease expired cleanly.
    Terminated,
    /// Terminal: the sandbox ended abnormally; see [`Sandbox::failure`].
    Failed,
}

impl SandboxState {
    /// The wire name, as used in the `state` list filter.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Terminated => "terminated",
            Self::Failed => "failed",
        }
    }
}

/// Enumerated cause recorded when a sandbox ends as `failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// The node hosting the sandbox disappeared.
    NodeLost,
    /// A resume could not restore the snapshot.
    RestoreFailed,
    /// The lease expired before the sandbox was paused or deleted.
    DeadlineExpired,
    /// The node drained without capturing a snapshot.
    DrainedWithoutCapture,
    /// No node acknowledged the sandbox within the create deadline.
    NeverAcknowledged,
    /// The pause snapshot's upload was abandoned.
    SnapshotUploadAbandoned,
    /// The pause snapshot aged past its restorable bound.
    SnapshotExpired,
}

/// Present exactly when [`Sandbox::state`] is [`SandboxState::Failed`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxFailure {
    /// The enumerated cause.
    pub reason: FailureReason,
    /// Free text expanding on the reason.
    pub detail: Option<String>,
    /// Whether issuing the failed request again would plausibly work.
    pub recoverable: bool,
}

/// Egress allow and deny lists, fixed at create.
///
/// Policy is part of the sandbox's identity, not mutable state a
/// caller can widen after the occupant is running. Entries are
/// hostnames or CIDR blocks; deny takes precedence.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressPolicy {
    /// Hostnames or CIDR blocks traffic may reach.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    /// Hostnames or CIDR blocks traffic must not reach; wins over allow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny: Option<Vec<String>>,
}

/// The compute shape, set by the template artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resources {
    /// Virtual CPU count; at least 1.
    pub vcpus: u32,
    /// Guest memory in MiB; at least 128.
    pub mem_mib: u64,
}

/// One sandbox, as the control plane reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sandbox {
    /// Lowercase alphanumeric identifier; never contains a hyphen (the
    /// hostname label separator).
    pub sandbox_id: String,
    /// Optional tenant-assigned name, unique within the organisation.
    pub name: Option<String>,
    /// The tenant-visible state.
    pub state: SandboxState,
    /// Present exactly when `state` is `failed`; absent otherwise.
    pub failure: Option<SandboxFailure>,
    /// The immutable artifact the sandbox was created from, resolved at
    /// admission time.
    pub template_artifact_id: String,
    /// The template alias the create named, if it named one.
    pub template: Option<String>,
    /// The instance generation. Advances on every resume; tokens are
    /// minted against an epoch and fail closed when it moves.
    pub epoch: i64,
    /// The sandbox domain suffix. A published port `p` is reachable at
    /// `https://<p>-<sandbox_id>.<domain>`.
    pub domain: String,
    /// Creation time, RFC 3339.
    pub created_at: String,
    /// When the lease expires, RFC 3339.
    pub deadline: String,
    /// Paused sandboxes only: the time past which the snapshot is no
    /// longer restorable, RFC 3339.
    pub restorable_until: Option<String>,
    /// Tenant key-value metadata, filterable in list.
    pub metadata: BTreeMap<String, String>,
    /// Absent when the sandbox was created without an egress policy.
    pub egress: Option<EgressPolicy>,
    /// The compute shape.
    pub resources: Resources,
}

/// One page of sandboxes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxList {
    /// The page, most recently created first.
    pub items: Vec<Sandbox>,
    /// Cursor for the next page; absent or null on the last page.
    pub next_cursor: Option<String>,
}

/// Body of `createSandbox`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSandboxRequest {
    /// A template alias or artifact ID. Aliases resolve at admission
    /// time. Required.
    pub template: String,
    /// Optional name, unique within the organisation. A colliding
    /// create fails with 409 instead of quietly producing a second
    /// sandbox.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Tenant key-value metadata, indexed for list filtering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, String>>,
    /// Requested lease length in seconds, from now. Omitted means the
    /// default lease.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_seconds: Option<u64>,
    /// Egress policy, fixed at create.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress: Option<EgressPolicy>,
}

/// Body of `resumeSandbox`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeSandboxRequest {
    /// Lease for the resumed instance in seconds, from now. Omitted
    /// means the default lease.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_seconds: Option<u64>,
}

/// Body of `extendSandboxDeadline`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtendDeadlineRequest {
    /// The new lease length in seconds, measured from now.
    pub deadline_seconds: u64,
}

/// Body of `mintSandboxToken`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MintTokenRequest {
    /// Requested token lifetime in seconds, bounded by the
    /// installation's maximum.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    /// Restrict the token to these ports. Omitted means the full scope
    /// the caller's credential permits; a scope can only narrow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<Vec<u16>>,
}

/// A capability token for one sandbox and epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityToken {
    /// The bearer credential for the sandbox data plane. Never logged.
    pub token: String,
    /// Expiry, RFC 3339.
    pub expires_at: String,
    /// The epoch the token was minted against.
    pub epoch: i64,
    /// The port scope, when narrowed. Null means the full scope.
    pub ports: Option<Vec<u16>>,
}

/// A sandbox together with a capability token for its current epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxWithToken {
    /// The sandbox.
    pub sandbox: Sandbox,
    /// A token for the sandbox's current epoch.
    pub token: CapabilityToken,
}

/// Exposure of one published port.
///
/// `private` (the default for every port): reachable at the port's
/// hostname with a capability token whose scope permits it. `public`:
/// anonymous traffic is admitted to this one tenant application port.
/// Reserved platform ports cannot be exposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortVisibility {
    /// Capability token required — the default for every port.
    Private,
    /// Anonymous traffic is admitted to this tenant application port.
    Public,
}

/// One port exposure record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortExposure {
    /// The port number.
    pub port: u16,
    /// The recorded visibility.
    pub visibility: PortVisibility,
    /// The port's public URL, `https://<port>-<sandbox_id>.<domain>`.
    pub url: String,
}

/// Body of `exposePort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExposePortRequest {
    /// The visibility to record.
    pub visibility: PortVisibility,
}

/// The sandbox's exposure records. A port with no record is private.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortList {
    /// Every exposure record on the sandbox.
    pub items: Vec<PortExposure>,
}

/// One recipe step, executed in order inside the build VM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildStep {
    /// The command the step runs.
    pub command: String,
    /// Environment for this step only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

/// Body of `createTemplateBuild`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateTemplateBuildRequest {
    /// OCI image reference. A tag is resolved to an immutable digest
    /// when the build starts and never consulted again. Required.
    pub image: String,
    /// Template alias to point at the artifact when the build
    /// succeeds; re-pointed atomically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Recipe steps, executed in order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<BuildStep>>,
    /// Command started at boot, before the warm snapshot is captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
    /// Readiness probe the warm-up waits for before capture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_command: Option<String>,
    /// The compute shape for sandboxes created from the artifact.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Resources>,
}

/// Template build progression. `queued` and `building` are in
/// progress; `succeeded` and `failed` are terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateBuildStatus {
    /// Accepted, not yet started.
    Queued,
    /// The build VM is running the recipe.
    Building,
    /// Terminal: the artifact exists; see [`TemplateBuild::artifact_id`].
    Succeeded,
    /// Terminal: the build failed; see [`TemplateBuild::error`].
    Failed,
}

/// One template build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateBuild {
    /// The build identifier.
    pub build_id: String,
    /// Where the build is in its lifecycle.
    pub status: TemplateBuildStatus,
    /// The image reference as requested.
    pub image: String,
    /// The resolved immutable digest, once resolution has happened.
    pub image_digest: Option<String>,
    /// The alias the build will point at the artifact, if requested.
    pub alias: Option<String>,
    /// The produced template artifact; present once the build succeeds.
    pub artifact_id: Option<String>,
    /// What failed; present exactly when `status` is `failed`.
    pub error: Option<String>,
    /// Creation time, RFC 3339.
    pub created_at: String,
    /// Terminal time, RFC 3339; present once the build finishes.
    pub finished_at: Option<String>,
}

/// One build log entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateBuildLogEntry {
    /// Entry time, RFC 3339.
    pub timestamp: String,
    /// The log line.
    pub message: String,
}

/// One page of build log entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateBuildLogs {
    /// The entries at and after the requested offset.
    pub entries: Vec<TemplateBuildLogEntry>,
    /// Pass as `offset` on the next poll.
    pub next_offset: u64,
}

/// One template record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    /// The template identifier.
    pub template_id: String,
    /// The mutable name pointing at the current artifact, if one is set.
    pub alias: Option<String>,
    /// The immutable artifact the alias currently resolves to.
    pub artifact_id: String,
    /// Free-text description.
    pub description: Option<String>,
    /// The compute shape the artifact fixes.
    pub resources: Option<Resources>,
    /// Creation time, RFC 3339.
    pub created_at: String,
}

/// One page of templates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateList {
    /// The page.
    pub items: Vec<Template>,
    /// Cursor for the next page; absent or null on the last page.
    pub next_cursor: Option<String>,
}

/// The one error shape every non-2xx response carries, on both planes.
///
/// The SDK folds this into [`crate::Error::Api`]; the type is public so
/// callers can parse error documents they obtained elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    /// Machine-readable cause, stable across releases. Examples:
    /// `invalid_request`, `not_found`, `name_taken`,
    /// `lifecycle_conflict`, `rate_limited`, `no_capacity`.
    pub code: String,
    /// Human-readable detail. Never contains credentials.
    pub message: String,
    /// Whether issuing the same request again would plausibly work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    /// The request identifier, for correlating with support and audit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Body of the data plane's `runCommand`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunCommandRequest {
    /// The program to run. Required.
    pub command: String,
    /// Arguments passed to the program.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Working directory. Omitted means the default user's home.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Environment variables set for this command only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// Bytes written to the command's stdin before it is closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    /// Kill the command if it has not exited after this long. Omitted
    /// means the agent's default; overrun returns HTTP 408.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

/// How a run-to-completion command ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    /// The command's exit code; negative means killed by a signal.
    pub exit_code: i64,
    /// Captured standard output.
    pub stdout: String,
    /// Captured standard error.
    pub stderr: String,
    /// True when output exceeded the capture limit. The streaming
    /// surface has no such limit.
    pub truncated: Option<bool>,
}

/// One process the agent supervises inside the sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Process {
    /// The process identifier.
    pub pid: u32,
    /// The command line the process was started with.
    pub command: String,
    /// Start time, RFC 3339.
    pub started_at: String,
    /// Whether the process is still running.
    pub running: bool,
    /// Whether the process owns a pseudo-terminal.
    pub pty: bool,
    /// Exit code after termination; negative means killed by a signal.
    pub exit_code: Option<i64>,
    /// Exit time, RFC 3339, after termination.
    pub exited_at: Option<String>,
}

/// The supervised processes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessList {
    /// Every supervised process.
    pub items: Vec<Process>,
}

/// Terminal dimensions for a process with a pseudo-terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtySize {
    /// Terminal columns.
    pub cols: u16,
    /// Terminal rows.
    pub rows: u16,
}

/// Body of `startProcess`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartProcessRequest {
    /// The program to start.
    pub command: String,
    /// Arguments passed to the program.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Working directory. Omitted means the default user's home.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Environment variables set for this process only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// Allocate a pseudo-terminal with these initial dimensions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty: Option<PtySize>,
}

/// Output stream represented by a retained process log chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessOutputStream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

/// One retained process output chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogChunk {
    /// Source output stream.
    pub stream: ProcessOutputStream,
    /// Monotonic output sequence.
    pub sequence: u64,
    /// UTF-8 output data.
    pub data: String,
}

/// Snapshot of retained output and process status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogs {
    /// Retained output chunks.
    pub chunks: Vec<ProcessLogChunk>,
    /// Sequence to use as `after` when requesting newer output.
    pub next_sequence: u64,
    /// Whether the process is still running.
    pub running: bool,
    /// Exit code after termination.
    pub exit_code: Option<i64>,
    /// Earliest missing sequence when old output was truncated.
    pub truncated_before: Option<u64>,
}

/// A validated event received from an attached process stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProcessStreamEvent {
    /// Standard output data.
    Stdout {
        /// Monotonic output sequence.
        sequence: u64,
        /// UTF-8 output data.
        data: String,
    },
    /// Standard error data.
    Stderr {
        /// Monotonic output sequence.
        sequence: u64,
        /// UTF-8 output data.
        data: String,
    },
    /// Terminal process status.
    Exit {
        /// Monotonic output sequence.
        sequence: u64,
        /// Process exit code.
        exit_code: i64,
    },
    /// A range of output is no longer retained.
    Gap {
        /// First missing sequence.
        from_sequence: u64,
        /// Last missing sequence.
        to_sequence: u64,
    },
}

/// Filesystem entry kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    /// Regular file.
    File,
    /// Directory.
    Directory,
    /// Symbolic link.
    Symlink,
    /// Another filesystem entry type.
    Other,
}

/// Metadata for one filesystem entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileInfo {
    /// Full entry path.
    pub path: String,
    /// Entry basename.
    pub name: String,
    /// Entry kind.
    pub kind: FileKind,
    /// Size in bytes.
    pub size: u64,
    /// Unix permission bits in octal.
    pub mode: String,
    /// Modification time, RFC 3339.
    pub modified_at: String,
    /// Symlink target, when this is a symlink.
    pub target: Option<String>,
}

/// Entries directly below a directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileList {
    /// Directory entries.
    pub items: Vec<FileInfo>,
}

/// Body of `makeDirectory`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MakeDirectoryRequest {
    /// Directory path.
    pub path: String,
    /// Create missing parent directories.
    pub parents: bool,
    /// Unix permission bits in octal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// Body of `moveFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveFileRequest {
    /// Existing path.
    pub source: String,
    /// Destination path.
    pub destination: String,
    /// Replace an existing destination.
    pub overwrite: bool,
}

/// A validated event received from a filesystem watch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FileWatchEvent {
    /// A filesystem entry was created.
    Created {
        /// Monotonic event sequence.
        sequence: u64,
        /// Affected path.
        path: String,
        /// Entry kind.
        kind: FileKind,
    },
    /// A filesystem entry was modified.
    Modified {
        /// Monotonic event sequence.
        sequence: u64,
        /// Affected path.
        path: String,
        /// Entry kind.
        kind: FileKind,
    },
    /// A filesystem entry moved.
    Moved {
        /// Monotonic event sequence.
        sequence: u64,
        /// New path.
        path: String,
        /// Previous path.
        old_path: String,
        /// Entry kind.
        kind: FileKind,
    },
    /// A filesystem entry was removed.
    Removed {
        /// Monotonic event sequence.
        sequence: u64,
        /// Affected path.
        path: String,
        /// Entry kind.
        kind: FileKind,
    },
    /// Kernel watch events were lost and the caller must rescan.
    Overflow {
        /// Monotonic event sequence.
        sequence: u64,
    },
}
