# Data-plane streaming protocol

Streaming uses WebSocket upgrades on the sandbox data-plane origin. The
client offers `fissionplane.v1` and
`fissionplane.token.<base64url-token>` as subprotocols. The server selects
`fissionplane.v1`; credentials never appear in the URL.

Messages are JSON text frames. Unknown message types are ignored so the
protocol can grow without breaking older clients.

## Process stream

Connect to:

```text
/processes/{pid}/stream?after={sequence}
```

`after` is the last output sequence the client has observed. The server
replays retained output after it, then follows live output.

Server messages:

```json
{"type":"stdout","sequence":1,"data":"hello\n"}
{"type":"stderr","sequence":2,"data":"warning\n"}
{"type":"exit","sequence":3,"exit_code":0}
{"type":"gap","from_sequence":1,"to_sequence":12}
```

Client messages:

```json
{"type":"input","data":"yes\n"}
{"type":"close_stdin"}
{"type":"resize","cols":120,"rows":40}
{"type":"signal","signal":"SIGINT"}
```

`resize` is valid only for a PTY process. PTY output uses `stdout`; a PTY
has no separate stderr stream. `gap` means the requested output is no
longer retained and the client must treat the missing range as lost.

The stream closes after `exit` has been delivered. A disconnect does not
stop the process. Reconnect with the last observed sequence to resume.

## File watch

Connect to:

```text
/files/watch?path={path}&recursive={boolean}&after={sequence}
```

Server messages:

```json
{"type":"created","sequence":1,"path":"/workspace/a.txt","kind":"file"}
{"type":"modified","sequence":2,"path":"/workspace/a.txt","kind":"file"}
{"type":"moved","sequence":3,"path":"/workspace/b.txt","old_path":"/workspace/a.txt","kind":"file"}
{"type":"removed","sequence":4,"path":"/workspace/b.txt","kind":"file"}
{"type":"overflow","sequence":5}
```

`overflow` means kernel events were lost. The client must rescan the
watched path before relying on later events. A watch ends when its
WebSocket closes; reconnect with the last observed sequence to resume
while events remain retained.
