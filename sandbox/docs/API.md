# Agent Sandbox API

All traffic enters through the **Router** gateway under `/v1`. Two planes:

- **Management API** — templates and sandbox lifecycle. Reverse-proxied to the Workload Manager (`pkg/router/server.go`).
- **Sandbox API** — code execution, files, sessions, terminal, GPU. Proxied to the in-Pod `envd` runtime (`pkg/envd/server.go`).

> This document is summarized from the API spec and verified against the current code.

## Service Endpoints

| Access     | Base URL                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| In-cluster | `http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080`   |

## Authentication

When the Router runs with `--enable-auth`, every `/v1/*` request must carry credentials:

- **Cookie** (browser): `Token=<safe-token>; userType=sso`
- **API Key** (SDK / CLI): `Authorization: Bearer ak-<your-key>`

Missing/invalid credentials return `401` with `{"error": "..."}`.

## Typical Flow

```
1. POST   /v1/templates                              create a template (one-time)
2. POST   /v1/code-interpreter                        create a sandbox -> sessionId
3. <Sandbox API> + x-session-id                       execute / files / etc.
4. DELETE /v1/code-interpreter/sessions/{sessionId}   delete the sandbox
```

---

## Management API

Source: `pkg/router/server.go`

| Method | Path                                      | Description                              |
| ------ | ----------------------------------------- | ---------------------------------------- |
| GET    | `/health`, `/v1/health`                   | Health check                             |
| POST   | `/v1/templates`                           | Create a template                        |
| POST   | `/v1/templates/stream`                    | Create a template (SSE)                  |
| GET    | `/v1/templates`                           | List templates (filter / page / sort)    |
| GET    | `/v1/templates/{namespace}/{name}`        | Get a template                           |
| PUT    | `/v1/templates/{namespace}/{name}`        | Update a template (full spec replace)    |
| DELETE | `/v1/templates/{namespace}/{name}`        | Delete a template (cascades WarmPool)    |
| POST   | `/v1/code-interpreter`                    | Create a sandbox (returns `sessionId`)   |
| POST   | `/v1/code-interpreter/stream`             | Create a sandbox (SSE)                   |
| GET    | `/v1/code-interpreter/sessions`           | List sandboxes (filter / page / sort)    |
| GET    | `/v1/code-interpreter/sessions/{id}`      | Get a sandbox                            |
| DELETE | `/v1/code-interpreter/sessions/{id}`      | Delete a sandbox                         |
| GET    | `/v1/sandbox/sessions/{id}/policy`        | Get egress policy                        |
| PATCH  | `/v1/sandbox/sessions/{id}/policy`        | Update egress policy                     |
| GET    | `/v1/sandbox/sessions/{id}/logs`          | Get session logs                         |

### Create a template (minimal)

```http
POST /v1/templates
Content-Type: application/json

{ "name": "python-311-runc", "namespace": "default",
  "spec": { "template": { "fromImage": "python:3.11-slim" } } }
```

Key `spec` fields: `template.fromImage` (required), `template.runtimeClassName`
(`""`=runc, `kata-qemu`=VM isolation), `template.resources`, `template.steps`
(`run`/`env`/`workdir`), `template.sidecars`, `gpu` (`count`, `product`,
`resourceName`, `sharedMemory`), `warmPoolSize` (default `0`),
`sessionTimeout` (default `15m`), `maxSessionDuration` (default `24h`),
`authMode` (`envd`|`none`). Template name must be DNS-1035 (`[a-z0-9-]`, no dots).
GPU sandboxes are `runc`-only.

### Create a sandbox

```http
POST /v1/code-interpreter
Content-Type: application/json

{ "name": "python-311-runc", "namespace": "default" }
```

Returns:

```json
{ "sessionId": "sess_6c0405b00854b1f80edbbd543493c834",
  "sandboxName": "python-311-runc-a3f8k2m1",
  "namespace": "default",
  "entryPoints": { "default": "http://...svc.cluster.local:8080" } }
```

`sessionId` is returned only once — save it. CPU/memory/GPU come from the
template; no runtime override.

---

## Sandbox API

All sandbox requests are proxied to the Pod through the gateway:

```
{METHOD} /v1/namespaces/{namespace}/code-interpreters/{name}/invocations/{endpoint}
```

Below, `{base}` denotes that prefix; `{endpoint}` is one of the routes below.
Methods supported: `GET, POST, DELETE, PUT, PATCH`.

Headers: credentials (Cookie or `Authorization: Bearer ak-...`) plus
`x-session-id`. If `x-session-id` is omitted, a `POST` auto-creates a sandbox
(and returns the new id in the `x-session-id` response header); non-`POST`
requests without a valid session return `404`. The Router caps concurrency at
1000 (`429` when exceeded).

Endpoints (source: `pkg/envd/server.go`):

| Category   | Method | Endpoint                       | Description                         |
| ---------- | ------ | ------------------------------ | ----------------------------------- |
| Health     | GET    | `/health`                      | Sandbox health check                |
| Execute    | POST   | `/api/execute`                 | Run a command synchronously         |
|            | POST   | `/api/execute/stream`          | Run a command, streamed via SSE     |
| Files      | POST   | `/api/files`                   | Upload (JSON Base64 or multipart)   |
|            | GET    | `/api/files/{path}`            | Download a file                     |
|            | GET    | `/api/files?path={dir}`        | List a directory                    |
|            | DELETE | `/api/files/{path}`            | Delete a file or directory          |
| Session    | POST   | `/api/session/create`          | Create a persistent shell session   |
|            | POST   | `/api/session/{id}/exec`       | Execute a command in the session    |
|            | GET    | `/api/session/{id}/output`     | Get session output                  |
|            | DELETE | `/api/session/{id}`            | Destroy the session                 |
| Terminal   | POST   | `/api/terminal/{id}/send_keys` | Send a key sequence                 |
|            | GET    | `/api/terminal/{id}/screen`    | Capture a terminal snapshot         |
| GPU        | GET    | `/api/gpu/status`              | Query AMD GPU status                |

### Execute (synchronous)

```http
POST {base}/api/execute
x-session-id: sess_xxx

{ "command": ["python3", "-c", "print(1+1)"], "timeout": "30s",
  "working_dir": "project/src", "env": { "MY_VAR": "value" } }
```

- `command` (`[]string`, required), `timeout` (default `60s`), `working_dir`
  (relative to workspace `/home/sandbox`; path traversal rejected with `400`),
  `env` (merged into the environment).
- Response (always `200`): `{ stdout, stderr, exit_code, duration, start_time, end_time }`.
  Check `exit_code` for success. Notable codes: `124` timeout, `126` not
  executable, `127` not found, `137` OOM-killed.

### Execute (streaming, SSE)

Same request body as above; `timeout` defaults to `300s`. Response is
`text/event-stream` with events: `start` (`{pid}`), `data`
(`{stdout}` or `{stderr}`), `end` (`{exit_code, exited, status}`; `status` is
`completed`/`failed`). Use `flush=True` to get line-by-line output.

### Files

- **Upload (JSON)**: `Content-Type: application/json`, body
  `{ path, content (base64), mode? }` → `201`. Body limit 32 MB (~24 MB raw).
- **Upload (multipart)**: `Content-Type: multipart/form-data`, fields `path` +
  `file` → `201`. Limit 32 MB. Same endpoint; the server picks the mode by `Content-Type`.
- **Download**: `GET {base}/api/files/{path}` → raw bytes.
- **List**: `GET {base}/api/files?path={dir}` → `{ files: [{name, size, mode, is_dir, mtime}] }`.
- **Delete**: `DELETE {base}/api/files/{path}` → `204` (recursive for dirs; cannot delete workspace root).

All paths are relative to the workspace; parent dirs are auto-created; traversal (`../`) is rejected.

### Persistent sessions (tmux)

State (cwd, env vars, background processes) persists across calls within a sandbox.

- **Create**: `POST {base}/api/session/create` → `{ "terminal_id": "ce429cf2" }` (default 200x50).
- **Exec**: `POST {base}/api/session/{id}/exec`, body `{ command (string), timeout?, working_dir? }`
  → `{ output, exit_code }` (`exit_code` `-1` = output-wait timeout; the command keeps running).
  Note: here `command` is a **string** (unlike `/api/execute`).
- **Output**: `GET {base}/api/session/{id}/output` → `{ output }` (poll long-running commands).
- **Destroy**: `DELETE {base}/api/session/{id}` → `204`.

### Interactive terminal

Same `id` as the session.

- **Send keys**: `POST {base}/api/terminal/{id}/send_keys`, body `{ "keys": ["print(1)", "Enter"] }`
  → `204`. Special keys: `Enter`, `Tab`, `Escape`, `Up`, `Down`, `C-c`, `C-d`.
  Plain text does not auto-append Enter; sending is async (wait ~0.3–1s before reading the screen).
- **Screen**: `GET {base}/api/terminal/{id}/screen` → `{ content, cursor_x, cursor_y, width, height }`.

### GPU status

`GET {base}/api/gpu/status` → always `200`.

```json
{ "available": true,
  "devices": [{ "id": 0, "name": "AMD Instinct MI300X",
    "memory_total": "206158430208", "memory_used": "2147483648",
    "utilization": 0, "temperature": 42 }],
  "rocm_version": "6.2.0" }
```

`available` is `false` (and `devices` is `null`) when no AMD GPU / `rocm-smi` is present.

---

## Errors & Status Codes

All errors return `{ "error": "..." }`.

| Code | Meaning      | Typical cause                                                        |
| ---- | ------------ | ------------------------------------------------------------------- |
| 200  | OK           | Execution (any `exit_code`), queries, GPU status                    |
| 201  | Created      | File upload                                                          |
| 204  | No Content   | Delete, send_keys                                                    |
| 400  | Bad Request  | Missing field, bad JSON, path traversal, base64 error, file too big |
| 401  | Unauthorized | Auth failed                                                         |
| 404  | Not Found    | Session expired / not found, file/template not found                |
| 405  | Not Allowed  | Wrong HTTP method for the endpoint                                  |
| 429  | Too Many Req | Concurrency limit (1000) exceeded                                    |
| 500  | Server Error | K8s op failed, session/file error                                   |
| 502  | Bad Gateway  | Sandbox unreachable / not ready                                     |
| 504  | Gateway Timeout | Sandbox response timed out (~2 min)                              |
