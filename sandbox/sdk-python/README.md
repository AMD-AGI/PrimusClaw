<!--
SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
SPDX-License-Identifier: Apache-2.0
-->

# agent_sandbox — Python SDK

An E2B-style Python client for the Agent Sandbox control plane: create an
isolated sandbox, run commands and code in it, move files in and out, and reach
services inside it over HTTP or a local port forward.

This directory is part of the `sandbox/` tree and is licensed under
**Apache-2.0**, not the repository's MIT license. See [`../LICENSE`](../LICENSE)
and [`../UPSTREAM.md`](../UPSTREAM.md).

## Install

```bash
pip install -e "sandbox/sdk-python/."          # library only
pip install -e "sandbox/sdk-python/.[cli]"     # library + sandbox-cli
pip install -e "sandbox/sdk-python/.[dev]"     # + pytest
```

Requires Python 3.10 or newer. The SDK talks to a running Sandbox Router — see
[`../deploy/`](../deploy) for how to stand one up.

## Quick start

```python
from agent_sandbox import Sandbox

with Sandbox(template="python-3.11") as sbx:
    print(sbx.exec("echo hello").stdout)

    # Files are resolved against the sandbox workspace.
    sbx.files.write("script.py", "print('hi from inside')")
    print(sbx.exec("python3 script.py").stdout)
```

The context manager opens the sandbox on entry and closes it on exit, including
on failure. For a lifecycle you control yourself, call `open()` and `close()`.

A `session` keeps shell state across calls, which a bare `exec` does not:

```python
session = sbx.session.create()
session.exec("cd /tmp")
session.exec("ls")        # still in /tmp
```

## What the SDK covers

| Area | Entry points |
|------|--------------|
| Lifecycle | `Sandbox(...)`, `open`, `close`, `list`, `get` |
| Execution | `exec`, `exec_stream`, `run_code`, `session.create` |
| Files | `files.write`, `read`, `read_text`, `upload`, `download`, `list`, `delete` |
| Networking | `get_service_url`, `http_request`, `port_forward` |
| Templates | `list_templates`, `get_template`, `create_template` |
| Operations | `gpu_status`, `get_logs`, `get_policy`, `update_policy` |

Full parameter documentation is generated from the docstrings — see the
[Python API reference](../../docs/api/) or build it locally with
`make verify-docs` from the repository root.

## CLI

Installing the `cli` extra provides `sandbox-cli`:

```bash
sandbox-cli config set --api-url https://<router-host> --api-key <key>
sandbox-cli sandbox create --template python-3.11
```

Configuration is stored per user; `sandbox-cli config show` prints the resolved
values.

## Things worth knowing before you rely on it

**TLS verification defaults to off.** `Sandbox(...)` takes `verify_ssl=False` by
default so that a router behind a self-signed certificate works out of the box,
and the package suppresses urllib3's warning about it at import time. Pass
`verify_ssl=True` against any endpoint you did not provision yourself.

**Sandboxes have an idle timeout.** The router reclaims a sandbox that goes
quiet; `--session-timeout` on the CLI and the equivalent SDK argument adjust it
within the platform's hard cap.

**Egress from inside the sandbox is filtered.** When the platform enables the
egress proxy, outbound traffic from your code reaches public endpoints but is
blocked from RFC 1918 ranges and cloud metadata addresses. Code that needs an
internal host must have it declared on the template.

**Inference credentials are injected, not configured.** Where the platform runs
an inference gateway, `OPENAI_BASE_URL` and `OPENAI_API_KEY` are supplied to the
sandbox process, so `import openai` works with no setup. This injection happens
for API-key authenticated sandboxes only — one created through browser cookie
auth does not get the key.

## Tests

```bash
pytest sandbox/sdk-python
```
