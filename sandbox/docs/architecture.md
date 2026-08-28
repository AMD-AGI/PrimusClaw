# Agent Sandbox Architecture

End-to-end view of how clients reach a sandbox and what runs inside the Pod.

```mermaid
flowchart TB
    subgraph Clients["Client access layer"]
        SDK["Python SDK"]
        CLI["sandbox-cli"]
        HTTP["HTTP API"]
        PF["Port Forward CLI"]
    end

    subgraph Platform["Platform services"]
        WM["Workload Manager<br/>+ image builder"]
        Router["Router<br/>+ SSRF protection<br/>+ port proxy"]
        LiteLLM["LiteLLM<br/>(inference gateway)"]
        Store["Redis Store<br/>+ Agentd (GC)"]
    end

    SDK & CLI & HTTP -->|control plane| WM
    SDK & CLI & HTTP -->|data plane| Router
    SDK & CLI & HTTP -->|inference| LiteLLM
    PF -->|port forward| Router

    WM -->|K8s API| Pod
    Router -->|HTTP| Pod
    LiteLLM -->|HTTP| Pod
    Store -.->|session state / GC| Router

    subgraph Pod["Sandbox Pod"]
        subgraph EnvD["EnvD (runtime agent)"]
            Exec["Command<br/>execution"]
            Files["File<br/>operations"]
            Term["Terminal<br/>sessions"]
            GPU["GPU<br/>status"]
            Egress["Egress proxy"]
            Policy["Policy engine"]
            Reload["Policy hot reload"]
        end
        Work["Workload container(s)"]
    end
```

## Components

| Component | Role |
| --- | --- |
| **Python SDK / sandbox-cli / HTTP API** | Client entry points for the management and sandbox APIs. |
| **Port Forward CLI** | Forwards a local port to a sandbox port through the Router's port proxy. |
| **Workload Manager** | Control plane: template/sandbox lifecycle on the K8s API, plus on-demand image building. |
| **Router** | Unified API gateway: routes data-plane invocations to the target Pod, with SSRF protection and port proxying. |
| **LiteLLM** | Inference gateway for OpenAI-compatible model calls from inside sandboxes. |
| **Redis Store + Agentd** | Session/state store and a background GC that reclaims expired sandboxes as a safety net. |
| **EnvD** | In-Pod runtime agent (port `8080`) exposing command execution, file operations, terminal sessions and GPU status, plus an egress proxy with a policy engine and hot policy reload. |
| **Workload container(s)** | The user's base image / sidecars running alongside EnvD. |

## Request planes

- **Control plane** — template and sandbox lifecycle, served by the Workload Manager.
- **Data plane** — code execution, files, sessions, terminal and GPU, served by EnvD and fronted by the Router.
- **Inference** — model calls routed through LiteLLM.
- **Port forward** — direct access to a sandbox port via the Router's port proxy.

See [API.md](./API.md) for the concrete HTTP routes.
