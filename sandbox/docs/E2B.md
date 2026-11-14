# E2B API

Agent Sandbox serves the [E2B](https://e2b.dev) control plane and data plane, so the official E2B SDK can create and use sandboxes on SaFE. Each sandbox is a SaFE Workload named by its sandbox id.

## Access

| Item          | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| Control plane | `https://<safe-host>/sandboxes`, `https://<safe-host>/v2/sandboxes` |
| Data plane    | `https://<safe-host>` (envd, routed by sandbox id)                  |
| API key       | SaFE API key (`ak-...`), sent as `X-API-Key`                        |
| SDK           | E2B Python SDK 2.51 or later                                        |

```bash
export E2B_API_KEY=ak-xxxx
export E2B_API_URL=https://<safe-host>
export E2B_SANDBOX_URL=https://<safe-host>
```

The data plane uses the `envdAccessToken` returned at create or connect. The SDK sends it as `X-Access-Token` together with `E2b-Sandbox-Id`.

## Keys

| Key                     | Issued by          | Scope                                                      |
| ----------------------- | ------------------ | ---------------------------------------------------------- |
| SaFE API key (`ak-...`) | SaFE console       | Owner quota of the caller; templates from the owner policy |
| Grant key (`e2b_...`)   | Claw sandbox grant | Role quota and templates of the grant                      |

A key is sent as `X-API-Key` or as `Authorization: Bearer <key>`. On the E2B routes `X-API-Key` wins when both are present. On the `/v1` management routes the order is reversed: the bearer token wins and `X-API-Key` is the fallback. A grant key is refused on `/v1` and is never sent to the identity provider.

A SaFE API key is checked with RFC 7662 token introspection at the identity provider. The first create or timeout call creates an owner record for the caller. Before that, list returns no sandboxes and get, connect, and kill return 404.

## Workspace

A sandbox runs in a SaFE workspace the caller belongs to.

- A caller in one workspace uses that workspace.
- A caller in several workspaces sets metadata `agent-sandbox.io/workspace`.
- A `system-admin` always sets metadata `agent-sandbox.io/workspace` and may choose any workspace.
- A workspace the caller does not belong to returns `403 user_not_in_workspace`.

## Templates

The operator defines the templates open to SaFE API keys in the owner policy (`E2B_OWNER_POLICY`). Ask the operator for the template ids of a deployment.

A template id has the form `e2b-<name>-g<gpus>`, one per GPU count listed for the template, or `e2b-<name>` when no GPU count is listed.

A template fixes:

- the image, pinned by digest; the caller cannot change it;
- the startup steps and environment;
- `acceptedEnvs`: the only environment variables a caller may pass; others return `403 env_not_allowed`;
- `sealed`, `inputs`, `outputs`: the sealed mode and its directories.

Sealed rules:

| Target                    | Read | Write |
| ------------------------- | ---- | ----- |
| `inputs` directories      | no   | yes   |
| `outputs` directories     | yes  | no    |
| other paths               | no   | no    |
| commands                  | no   | no    |

A template that is not sealed allows commands and file access in the sandbox.

### User templates

A user creates a template for a workspace with `POST /v1/templates` and the `workspace` field (see [API.md](API.md)). Its template id is the template name. A name cannot start with `e2b-`. User templates are used with SaFE API keys; a grant key runs only the templates of its role.

- The template id is matched exactly: first against the owner policy, then against user templates. An id that matches neither returns `404 template_not_found`.
- A caller may use its own templates and public templates. Another user's private template returns `404 template_not_found`; a `system-admin` may use any.
- The sandbox runs in the template workspace. The caller must belong to it, and metadata `agent-sandbox.io/workspace`, when set, must name it (`400 workspace_mismatch`).
- The quota of the caller applies. A user template accepts no environment variables from the caller, except from a `system-admin`.

## Quotas

Quotas apply per person, across all templates. The built-in defaults are below; the owner policy can override the user quota, the `system-admin` quota, or the quota of one user. A field the policy leaves out keeps the built-in value; a field left out of one user's quota comes from the user or `system-admin` quota of that user.

| Caller         | Concurrent sandboxes | Concurrent GPUs | Max lifetime per sandbox |
| -------------- | -------------------- | --------------- | ------------------------ |
| User           | 8                    | 8               | 12 hours                 |
| `system-admin` | unlimited            | unlimited       | 3 days                   |

- The create timeout and every extension stay within the max lifetime.
- The timeout and the max lifetime count from the time the sandbox is running. Time spent queued or pending is not part of either.
- The wait for a sandbox to run is the pending timeout: metadata `agent-sandbox.io/pending-timeout` in seconds (1 to 86400) when set, else the template `pendingTimeoutSec`, else 15 minutes. A sandbox not running by then is removed. The create returns `503 pending_timeout` with the limit and the last queue state; a replay of its idempotency key returns `410 idempotency_key_spent` with that `pending_timeout` reason in the detail.
- An expired sandbox is reclaimed. Kill releases the quota at once.
- A user lists and operates only their own sandboxes. Another user's sandbox returns `404`.
- A `system-admin` operates every sandbox, including Claw grant sandboxes. An extension stays within both the caller's max lifetime and that of the sandbox's owner.
- A `system-admin` list returns their own sandboxes. The metadata filter `agent-sandbox.io/scope=all` lists every sandbox; those results carry `agent-sandbox.io/owner-user-id`, and the list can filter on it. Other callers ignore that filter.

## Example

```python
from e2b import Sandbox

sbx = Sandbox.create(
    "<template-id>",
    timeout=1800,
    metadata={"purpose": "e2b-trial"},
    # metadata={"agent-sandbox.io/workspace": "<workspace-id>"},
    # envs={"<ACCEPTED_ENV>": "<value>"},
    request_timeout=900,
)
print(sbx.sandbox_id)

# Template that is not sealed
print(sbx.commands.run("echo hello").stdout)

# Sealed template: write inputs, read outputs
# sbx.files.write("<input-dir>/spec.json", "{}")
# print(sbx.files.read("<output-dir>/result.json"))

sbx.set_timeout(3600)
print([s.sandbox_id for s in Sandbox.list().next_items()])
sbx.kill()
```

Control plane with curl:

```bash
curl -s -H "X-API-Key: $E2B_API_KEY" $E2B_API_URL/sandboxes
curl -s -X POST -H "X-API-Key: $E2B_API_KEY" -H "Content-Type: application/json" \
  -d '{"templateID":"<template-id>","timeout":1800}' $E2B_API_URL/sandboxes
curl -s -X POST -H "X-API-Key: $E2B_API_KEY" -H "Content-Type: application/json" \
  -d '{"timeout":3600}' $E2B_API_URL/sandboxes/<sandboxID>/timeout
curl -s -X DELETE -H "X-API-Key: $E2B_API_KEY" $E2B_API_URL/sandboxes/<sandboxID>
```

## SDK networking

The E2B SDK uses the pyqwest HTTP client, which resolves names with its own resolver and trusts its bundled CA set. On hosts that rely on the system resolver or a private CA, build its transports with system DNS and the CA chain before importing `e2b`:

```python
import pyqwest

CA = open("/path/to/ca-chain.pem", "rb").read()

def _with_system_dns(cls):
    """Build pyqwest transports with system DNS and the given CA chain."""
    def make(*args, **kwargs):
        kwargs["use_system_dns"] = True
        kwargs["tls_ca_cert"] = CA
        kwargs["tls_include_system_certs"] = True
        return cls(*args, **kwargs)
    return make

pyqwest.HTTPTransport = _with_system_dns(pyqwest.HTTPTransport)
pyqwest.SyncHTTPTransport = _with_system_dns(pyqwest.SyncHTTPTransport)

from e2b import Sandbox
```

## Errors

| Status | Code                    | Meaning                                           |
| ------ | ----------------------- | ------------------------------------------------- |
| 401    | `invalid_key`           | Key is unknown, inactive, or expired              |
| 403    | `timeout_not_allowed`   | Timeout exceeds the max lifetime                  |
| 400    | `workspace_mismatch`    | Workspace metadata differs from the template's    |
| 403    | `template_not_allowed`  | Template is not allowed for the caller            |
| 403    | `env_not_allowed`       | Environment variable is not accepted              |
| 403    | `metadata_reserved`     | Metadata key is reserved by the platform          |
| 403    | `user_not_in_workspace` | Caller is not a member of the workspace           |
| 403    | `sealed_denied`         | Path or call is outside the sealed allow-list     |
| 404    | `template_not_found`    | No template the caller may use has this id        |
| 404    | `sandbox_not_found`     | Sandbox does not exist or belongs to another user |
| 410    | `idempotency_key_spent` | Key already ended; the detail carries the reason  |
| 503    | `pending_timeout`       | Sandbox was not running within the pending timeout |
| 503    | `identity_unavailable`  | Identity or the user record cannot be read        |

A create that waits for a free GPU stays pending until the Workload is scheduled; a larger `request_timeout` keeps the call open while it waits.
