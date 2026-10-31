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

A SaFE API key is checked with primus-identity introspection. The first create or timeout call creates an owner record for the caller. Before that, list returns no sandboxes and get, connect, and kill return 404.

## Workspace

A sandbox runs in a SaFE workspace the caller belongs to.

- A caller in one workspace uses that workspace.
- A caller in several workspaces sets metadata `agent-sandbox.io/workspace`.
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

## Quotas

Quotas apply per person, across all templates. The built-in defaults are below; the owner policy can override the user quota, the `system-admin` quota, or the quota of one user.

| Caller         | Concurrent sandboxes | Concurrent GPUs | Max lifetime per sandbox |
| -------------- | -------------------- | --------------- | ------------------------ |
| User           | 8                    | 8               | 12 hours                 |
| `system-admin` | unlimited            | unlimited       | 3 days                   |

- The create timeout and every extension stay within the max lifetime.
- An expired sandbox is reclaimed. Kill releases the quota at once.
- A user lists and operates only their own sandboxes. Another user's sandbox returns `404`.
- A `system-admin` lists and operates every sandbox, including Claw grant sandboxes. List results carry `agent-sandbox.io/owner-user-id`.

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
| 403    | `template_not_allowed`  | Template is not in the caller's policy            |
| 403    | `env_not_allowed`       | Environment variable is not accepted              |
| 403    | `metadata_reserved`     | Metadata key is reserved by the platform          |
| 403    | `user_not_in_workspace` | Caller is not a member of the workspace           |
| 403    | `sealed_denied`         | Path or call is outside the sealed allow-list     |
| 404    | `sandbox_not_found`     | Sandbox does not exist or belongs to another user |
| 503    | `identity_unavailable`  | primus-identity cannot be reached                 |

A create that waits for a free GPU stays pending until the Workload is scheduled; a larger `request_timeout` keeps the call open while it waits.
