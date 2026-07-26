//! Guards the hand-written models against the OpenAPI contracts.
//!
//! The TypeScript and Python SDKs generate their API layer from
//! `src/contracts/*.yaml`; this crate is written by hand, so nothing but
//! a test stops a model from drifting away from the document it mirrors.
//! For every schema the crate models, this asserts that the schema still
//! exists, that no field the model serializes has disappeared from it,
//! that no property has appeared that the model ignores, and that no
//! required property is silently dropped.
//!
//! Each model is built field by field on purpose: adding a field to
//! `models.rs` breaks this file until the field is accounted for here.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;
use std::path::{Path, PathBuf};

use fissionplane::models::{
    ApiError, BuildStep, CapabilityToken, CommandResult, CreateSandboxRequest,
    CreateTemplateBuildRequest, EgressPolicy, ExposePortRequest, ExtendDeadlineRequest,
    FailureReason, FileInfo, FileKind, FileList, MakeDirectoryRequest, MintTokenRequest,
    MoveFileRequest, PortExposure, PortList, PortVisibility, Process, ProcessList, ProcessLogChunk,
    ProcessLogs, ProcessOutputStream, PtySize, Resources, ResumeSandboxRequest, RunCommandRequest,
    Sandbox, SandboxFailure, SandboxList, SandboxState, SandboxWithToken, StartProcessRequest,
    Template, TemplateBuild, TemplateBuildLogEntry, TemplateBuildLogs, TemplateBuildStatus,
    TemplateList,
};
use serde::Serialize;
use serde_json::Value;

#[test]
fn control_plane_models_match_the_contract() {
    let contract = Contract::load("openapi.yaml");

    contract.fields(
        "SandboxFailure",
        &SandboxFailure {
            reason: FailureReason::NodeLost,
            detail: Some("the node stopped reporting".to_owned()),
            recoverable: false,
        },
    );
    contract.fields(
        "EgressPolicy",
        &EgressPolicy {
            allow: Some(vec!["registry.example.com".to_owned()]),
            deny: Some(vec!["10.0.0.0/8".to_owned()]),
        },
    );
    contract.fields(
        "Resources",
        &Resources {
            vcpus: 2,
            mem_mib: 1024,
        },
    );
    contract.fields("Sandbox", &sandbox());
    contract.fields(
        "SandboxList",
        &SandboxList {
            items: vec![sandbox()],
            next_cursor: Some("c1".to_owned()),
        },
    );
    contract.fields(
        "CreateSandboxRequest",
        &CreateSandboxRequest {
            template: "base".to_owned(),
            name: Some("demo".to_owned()),
            metadata: Some(BTreeMap::new()),
            deadline_seconds: Some(600),
            egress: Some(EgressPolicy::default()),
        },
    );
    contract.fields(
        "ResumeSandboxRequest",
        &ResumeSandboxRequest {
            deadline_seconds: Some(600),
        },
    );
    contract.fields(
        "ExtendDeadlineRequest",
        &ExtendDeadlineRequest {
            deadline_seconds: 900,
        },
    );
    contract.fields(
        "MintTokenRequest",
        &MintTokenRequest {
            ttl_seconds: Some(300),
            ports: Some(vec![3000]),
        },
    );
    contract.fields("CapabilityToken", &token());
    contract.fields(
        "SandboxWithToken",
        &SandboxWithToken {
            sandbox: sandbox(),
            token: token(),
        },
    );
    contract.fields(
        "PortExposure",
        &PortExposure {
            port: 3000,
            visibility: PortVisibility::Public,
            url: "https://3000-sbx1.sandboxes.example.com".to_owned(),
        },
    );
    contract.fields(
        "ExposePortRequest",
        &ExposePortRequest {
            visibility: PortVisibility::Private,
        },
    );
    contract.fields("PortList", &PortList { items: Vec::new() });
    contract.fields(
        "BuildStep",
        &BuildStep {
            command: "apt-get install -y curl".to_owned(),
            env: Some(BTreeMap::new()),
        },
    );
    contract.fields(
        "CreateTemplateBuildRequest",
        &CreateTemplateBuildRequest {
            image: "docker.io/library/python:3.13".to_owned(),
            alias: Some("python".to_owned()),
            steps: Some(Vec::new()),
            start_command: Some("python -m http.server".to_owned()),
            ready_command: Some("curl -sf localhost:8000".to_owned()),
            resources: Some(Resources {
                vcpus: 2,
                mem_mib: 1024,
            }),
        },
    );
    contract.fields(
        "TemplateBuild",
        &TemplateBuild {
            build_id: "bld1".to_owned(),
            status: TemplateBuildStatus::Succeeded,
            image: "docker.io/library/python:3.13".to_owned(),
            image_digest: Some("sha256:abc".to_owned()),
            alias: Some("python".to_owned()),
            artifact_id: Some("sha256:def".to_owned()),
            error: Some("no error".to_owned()),
            created_at: "2026-07-28T12:00:00Z".to_owned(),
            finished_at: Some("2026-07-28T12:05:00Z".to_owned()),
        },
    );
    contract.fields(
        "TemplateBuildLogEntry",
        &TemplateBuildLogEntry {
            timestamp: "2026-07-28T12:00:00Z".to_owned(),
            message: "step 1/3".to_owned(),
        },
    );
    contract.fields(
        "TemplateBuildLogs",
        &TemplateBuildLogs {
            entries: Vec::new(),
            next_offset: 12,
        },
    );
    contract.fields(
        "Template",
        &Template {
            template_id: "tpl1".to_owned(),
            alias: Some("python".to_owned()),
            artifact_id: "sha256:def".to_owned(),
            description: Some("python with tooling".to_owned()),
            resources: Some(Resources {
                vcpus: 2,
                mem_mib: 1024,
            }),
            created_at: "2026-07-28T12:00:00Z".to_owned(),
        },
    );
    contract.fields(
        "TemplateList",
        &TemplateList {
            items: Vec::new(),
            next_cursor: Some("c1".to_owned()),
        },
    );
    contract.fields("Error", &api_error());

    contract.values(
        "SandboxState",
        &[
            SandboxState::Running,
            SandboxState::Paused,
            SandboxState::Terminated,
            SandboxState::Failed,
        ],
    );
    contract.values(
        "FailureReason",
        &[
            FailureReason::NodeLost,
            FailureReason::RestoreFailed,
            FailureReason::DeadlineExpired,
            FailureReason::DrainedWithoutCapture,
            FailureReason::NeverAcknowledged,
            FailureReason::SnapshotUploadAbandoned,
            FailureReason::SnapshotExpired,
        ],
    );
    contract.values(
        "PortVisibility",
        &[PortVisibility::Private, PortVisibility::Public],
    );
    contract.values(
        "TemplateBuildStatus",
        &[
            TemplateBuildStatus::Queued,
            TemplateBuildStatus::Building,
            TemplateBuildStatus::Succeeded,
            TemplateBuildStatus::Failed,
        ],
    );
}

#[test]
fn data_plane_models_match_the_contract() {
    let contract = Contract::load("dataplane.yaml");

    contract.fields(
        "RunCommandRequest",
        &RunCommandRequest {
            command: "python".to_owned(),
            args: Some(vec!["-V".to_owned()]),
            cwd: Some("/workspace".to_owned()),
            env: Some(BTreeMap::new()),
            stdin: Some(String::new()),
            timeout_seconds: Some(30),
        },
    );
    contract.fields(
        "CommandResult",
        &CommandResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            truncated: Some(false),
        },
    );
    contract.fields(
        "StartProcessRequest",
        &StartProcessRequest {
            command: "bash".to_owned(),
            args: Some(Vec::new()),
            cwd: Some("/workspace".to_owned()),
            env: Some(BTreeMap::new()),
            pty: Some(PtySize { cols: 80, rows: 24 }),
        },
    );
    contract.fields("PtySize", &PtySize { cols: 80, rows: 24 });
    contract.fields("Process", &process());
    contract.fields(
        "ProcessList",
        &ProcessList {
            items: vec![process()],
        },
    );
    contract.fields(
        "ProcessLogChunk",
        &ProcessLogChunk {
            stream: ProcessOutputStream::Stdout,
            sequence: 1,
            data: "ready\n".to_owned(),
        },
    );
    contract.fields(
        "ProcessLogs",
        &ProcessLogs {
            chunks: Vec::new(),
            next_sequence: 1,
            running: true,
            exit_code: Some(0),
            truncated_before: Some(0),
        },
    );
    contract.fields("FileInfo", &file_info());
    contract.fields(
        "FileList",
        &FileList {
            items: vec![file_info()],
        },
    );
    contract.fields(
        "MakeDirectoryRequest",
        &MakeDirectoryRequest {
            path: "/workspace/new".to_owned(),
            parents: true,
            mode: Some("0755".to_owned()),
        },
    );
    contract.fields(
        "MoveFileRequest",
        &MoveFileRequest {
            source: "/workspace/a".to_owned(),
            destination: "/workspace/b".to_owned(),
            overwrite: true,
        },
    );
    contract.fields("Error", &api_error());

    contract.values(
        "FileKind",
        &[
            FileKind::File,
            FileKind::Directory,
            FileKind::Symlink,
            FileKind::Other,
        ],
    );
}

fn sandbox() -> Sandbox {
    Sandbox {
        sandbox_id: "sbx1".to_owned(),
        name: Some("demo".to_owned()),
        state: SandboxState::Running,
        failure: Some(SandboxFailure {
            reason: FailureReason::NodeLost,
            detail: None,
            recoverable: true,
        }),
        template_artifact_id: "sha256:def".to_owned(),
        template: Some("base".to_owned()),
        epoch: 1,
        domain: "sandboxes.example.com".to_owned(),
        created_at: "2026-07-28T12:00:00Z".to_owned(),
        deadline: "2026-07-28T13:00:00Z".to_owned(),
        restorable_until: Some("2026-07-29T13:00:00Z".to_owned()),
        metadata: BTreeMap::new(),
        egress: Some(EgressPolicy::default()),
        resources: Resources {
            vcpus: 2,
            mem_mib: 1024,
        },
    }
}

fn token() -> CapabilityToken {
    CapabilityToken {
        token: "tok1".to_owned(),
        expires_at: "2026-07-28T12:10:00Z".to_owned(),
        epoch: 1,
        ports: Some(vec![3000]),
    }
}

fn process() -> Process {
    Process {
        pid: 42,
        command: "python server.py".to_owned(),
        started_at: "2026-07-28T12:00:00Z".to_owned(),
        running: true,
        pty: false,
        exit_code: Some(0),
        exited_at: Some("2026-07-28T12:01:00Z".to_owned()),
    }
}

fn file_info() -> FileInfo {
    FileInfo {
        path: "/workspace/a.txt".to_owned(),
        name: "a.txt".to_owned(),
        kind: FileKind::File,
        size: 3,
        mode: "0644".to_owned(),
        modified_at: "2026-07-28T12:00:00Z".to_owned(),
        target: Some("/workspace/b.txt".to_owned()),
    }
}

fn api_error() -> ApiError {
    ApiError {
        code: "invalid_request".to_owned(),
        message: "the request is malformed".to_owned(),
        retryable: Some(false),
        request_id: Some("req1".to_owned()),
    }
}

/// The `components.schemas` section of one contract.
struct Contract {
    file: String,
    schemas: BTreeMap<String, Schema>,
}

impl Contract {
    fn load(file: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../contracts")
            .join(file);
        Self {
            file: file.to_owned(),
            schemas: read_schemas(&path),
        }
    }

    fn schema(&self, name: &str) -> &Schema {
        self.schemas.get(name).unwrap_or_else(|| {
            panic!(
                "{}: the crate models schema {name}, which the contract no longer defines; \
                 defined schemas are {:?}",
                self.file,
                self.schemas.keys().collect::<Vec<_>>()
            )
        })
    }

    /// Asserts that the model's serialized fields and the schema's
    /// properties are the same set, and that nothing required is
    /// missing.
    fn fields<T: Serialize>(&self, name: &str, model: &T) {
        let schema = self.schema(name);
        let serialized = match serde_json::to_value(model) {
            Ok(Value::Object(fields)) => fields,
            other => panic!(
                "{}: {name} does not serialize to an object: {other:?}",
                self.file
            ),
        };
        let modelled: BTreeSet<&str> = serialized.keys().map(String::as_str).collect();

        for field in &modelled {
            assert!(
                schema.properties.contains(*field),
                "{}: the model serializes {name}.{field}, which is not a property of the \
                 contract schema; rename or remove it in models.rs",
                self.file,
            );
        }
        for property in &schema.properties {
            assert!(
                modelled.contains(property.as_str()),
                "{}: the contract defines {name}.{property}, which no field of the model \
                 carries; add it to models.rs",
                self.file,
            );
        }
        for property in &schema.required {
            assert!(
                modelled.contains(property.as_str()),
                "{}: {name}.{property} is required by the contract and the model drops it",
                self.file,
            );
        }
    }

    /// Asserts that an enum's wire values are exactly the contract's.
    fn values<T: Serialize + Debug>(&self, name: &str, variants: &[T]) {
        let schema = self.schema(name);
        let modelled: BTreeSet<String> = variants
            .iter()
            .map(|variant| match serde_json::to_value(variant) {
                Ok(Value::String(value)) => value,
                other => panic!(
                    "{}: {name} variant {variant:?} is not a string: {other:?}",
                    self.file
                ),
            })
            .collect();
        assert_eq!(
            modelled, schema.values,
            "{}: the {name} variants and the contract's enum have diverged",
            self.file,
        );
    }
}

/// Everything this test needs from one contract schema.
#[derive(Debug, Default)]
struct Schema {
    properties: BTreeSet<String>,
    required: BTreeSet<String>,
    values: BTreeSet<String>,
}

/// Which list the indented lines below the current key belong to.
enum Section {
    Properties,
    Required,
    Values,
    Other,
}

/// Reads `components.schemas` out of an OpenAPI document.
///
/// Deliberately not a YAML parser. The workspace carries no YAML crate,
/// and the obvious candidate is unmaintained, which `cargo deny` rejects;
/// both contracts are also written in one narrow style — schema names at
/// four spaces, schema keys at six, property names and list items at
/// eight — so a reader tuned to exactly that style is enough. Anything
/// more deeply nested is ignored, so reformatting a contract can only
/// make this test stop looking at a schema, never make it report a field
/// that is really there.
fn read_schemas(path: &Path) -> BTreeMap<String, Schema> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    let mut schemas: BTreeMap<String, Schema> = BTreeMap::new();
    let mut current = String::new();
    let mut section = Section::Other;
    let mut inside = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent < 4 {
            // A new `components` child: either the schemas or something
            // this test does not read.
            inside = indent == 2 && trimmed == "schemas:";
            current.clear();
            section = Section::Other;
            continue;
        }
        if !inside {
            continue;
        }
        match indent {
            4 => {
                let (name, _) = split_key(trimmed).unwrap_or_else(|| {
                    panic!("{}: unexpected schema line {trimmed:?}", path.display())
                });
                current = name.to_owned();
                schemas.entry(current.clone()).or_default();
                section = Section::Other;
            },
            6 => {
                let Some((key, value)) = split_key(trimmed) else {
                    section = Section::Other;
                    continue;
                };
                let schema = schemas.entry(current.clone()).or_default();
                section = match key {
                    "properties" => Section::Properties,
                    "required" => {
                        schema.required.extend(inline_list(value));
                        Section::Required
                    },
                    "enum" => {
                        schema.values.extend(inline_list(value));
                        Section::Values
                    },
                    _ => Section::Other,
                };
            },
            8 => {
                let schema = schemas.entry(current.clone()).or_default();
                match section {
                    Section::Properties => {
                        if let Some((name, _)) = split_key(trimmed) {
                            schema.properties.insert(name.to_owned());
                        }
                    },
                    Section::Required => {
                        if let Some(item) = trimmed.strip_prefix("- ") {
                            schema.required.insert(item.trim().to_owned());
                        }
                    },
                    Section::Values => {
                        if let Some(item) = trimmed.strip_prefix("- ") {
                            schema.values.insert(item.trim().to_owned());
                        }
                    },
                    Section::Other => {},
                }
            },
            _ => {},
        }
    }
    assert!(
        !schemas.is_empty(),
        "{}: found no schemas, so the reader has stopped matching the document's style",
        path.display()
    );
    schemas
}

fn split_key(line: &str) -> Option<(&str, &str)> {
    let (key, rest) = line.split_once(':')?;
    Some((key.trim().trim_matches('\''), rest.trim()))
}

/// The items of a flow sequence such as `[running, paused]`. An empty
/// string (a block sequence follows on the next lines) yields nothing.
fn inline_list(value: &str) -> Vec<String> {
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}
