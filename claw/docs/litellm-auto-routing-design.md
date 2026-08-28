# LiteLLM Auto Routing Design

Gateway-side Auto Routing for PrimusClaw, plus a client-visible `routed_model`
on each LLM turn. Brain does **not** pick a model per turn. The public
`DEFAULT_MODEL` is **not** switched in this change.

## 1. Goals

- Route SIMPLE / MEDIUM / COMPLEX / REASONING traffic at the LiteLLM proxy.
- Claw still sends one model string for the whole agent-loop session.
- After every LLM call, session SSE tells the client which backend served it.
- Roll back by pointing `DEFAULT_MODEL` at a pinned flagship name. No Brain
  loop rewrite.

## 2. Why the gateway, not Brain

[`agent/engine.ts`](../packages/brain/src/agent/engine.ts) fixes
`request.model || DEFAULT_MODEL` at run start.
[`agent/agent-loop.ts`](../packages/brain/src/agent/agent-loop.ts) reuses one `LlmSession`
for the whole session. Per-turn selection in Brain would fight prompt cache,
Anthropic `thinking` blocks, and the existing session headers
(`session_id`, `x-auto-prompt-caching`).

LiteLLM `auto_router/complexity_router` (v1.94+, classifier context window in
v1.96+) classifies inside the proxy. Brain keeps sending `claude-auto`.

```
Brain  model=claude-auto
  → LiteLLM >= v1.96.2
    → apim_key_hook (cache_control when the alias contains "claude")
      → complexity_router
        → SIMPLE Haiku / MEDIUM Sonnet / COMPLEX|REASONING flagship
```

Do **not** bind these to the auto-router:

- `WEB_FETCH_SUMMARIZE_MODEL` — safe by default: it has its own literal
  default (`claude-3-5-haiku-latest`) and never reads `DEFAULT_MODEL`.
- `MEMORY_LLM_MODEL` — **not** safe by default. It is
  `env("MEMORY_LLM_MODEL", env("DEFAULT_MODEL", …))`
  ([`api/src/config.ts`](../packages/api/src/config.ts)), so setting
  `DEFAULT_MODEL=claude-auto` silently routes memory extraction and skill
  evolution through the router too. Any environment that opts in **must** pin
  `MEMORY_LLM_MODEL` explicitly in the same change.

Conversation compaction uses the main session model. `session_affinity: true`
keeps thinking blocks on one backend for the session.

## 3. Image pin

[`deploy/litellm/Dockerfile`](../../deploy/litellm/Dockerfile) pins

`ghcr.io/berriai/litellm:v1.96.2@sha256:154e23bb5f31b1f10e16392a8ef299bd2cde08de3a64a6849002cfcc25ce3c63`

v1.96.2 is the floor for Auto Router v2 **and**
`classifier_context_window_size`. The Dockerfile still locates
`litellm.proxy.hooks` at runtime before copying `apim_key_hook.py`, and the
UI `/ui` → `/llm-gateway` patch is skipped if the prebuilt `out` directory is
missing.

**Bumping this Dockerfile deploys nothing on its own.** No deploy path builds
from it: [`deploy/litellm/deploy.sh`](../../deploy/litellm/deploy.sh) defaults
`LITELLM_IMAGE` to a prebuilt `docker.io/primussafe/litellm:<timestamp>`, and
[`charts/litellm/values.yaml`](../../deploy/litellm/charts/litellm/values.yaml) pins
the same tag, which `deploy.sh` then overrides with `--set image.tag=`. Enable
the router against that image and you get a 1.83 proxy with no
`auto_router/complexity_router`, so every `claude-auto` call fails. The rollout
is therefore three steps, in order:

1. `docker build -t <registry>/litellm:<new-tag> deploy/litellm/` and push it.
2. Deploy with `LITELLM_IMAGE=<registry>/litellm:<new-tag>`, and verify the
   running proxy reports `1.96.2` before going further.
3. Only then supply the router entry and set `DEFAULT_MODEL=claude-auto`.

## 4. Alias and cache hook

[`apim_key_hook.py`](../../deploy/litellm/apim_key_hook.py) injects Anthropic
`cache_control` only when `"claude" in model` (or the name starts with
`anthropic/`). The router alias **must** contain `claude`. Use `claude-auto`.

A name like `smart-router` would silently skip prompt-cache injection.

## 5. v1 routing policy (quality first)

| Tier | Backend (example ids) |
|------|------------------------|
| SIMPLE | already-deployed Haiku |
| MEDIUM | Sonnet |
| COMPLEX / REASONING | current flagship (`claude-opus-4-7` in the public chart default) |

- LLM classifier on Haiku, `timeout_ms: 2000`
- `classifier_context_window_size: 3`
- `session_affinity: true`, TTL 3600s (prompt cache + thinking blocks)
- `return_raw_model_name: true` so stream `model` is the backend when the
  header is unavailable
- Optional keyword escalate: architecture / debug / refactor → REASONING
- Do **not** enable `adaptive` or routing plugins

Classifier failure falling back to the heuristic scorer is unconditional in
v1.96.2 (`ComplexityRouter._classify` catches every exception), so it needs no
config key. `classifier_fallback` is **not** a field on `ComplexityRouterConfig`
at this pin — the model is `extra="allow"`, so setting it is accepted and
silently ignored. Do not add it expecting `default_model` behaviour.

`session_affinity` needs a session id, and the router reads exactly one place:
`metadata.session_id`, which the proxy fills only from `x-litellm-trace-id` /
`x-litellm-session-id` (or any `x-<vendor>-session-id`). Both Brain providers
send `x-litellm-session-id` for this reason. The session id inside
`x-litellm-spend-logs-metadata` is a JSON blob the router never parses — with
that alone, `session_affinity: true` is configured but inert and the backend
can change mid-conversation.

`session_affinity` is opt-in in LiteLLM (default false as of v1.97 docs).
Claw sets it true on purpose: a mid-session model change can break Anthropic
thinking replay and cold-start the cache.

## 6. Helm

Public [`deploy/litellm/charts/litellm/values.yaml`](../../deploy/litellm/charts/litellm/values.yaml)
keeps `modelList: []`. Secrets stay in a private `LITELLM_VALUES_FILE`.

The ConfigMap already `toYaml`s the whole list. Auto Router is one more
`modelList` entry (`model: auto_router/complexity_router` plus
`complexity_router_config`). No chart schema change.

Copy [`deploy/litellm/values.autorouting.example.yaml`](../../deploy/litellm/values.autorouting.example.yaml)
(placeholders only) into the private file.

`deploy.sh` interactive `/models` discovery **overwrites** `modelList` from
`LITELLM_VALUES_FILE`. Skip that prompt when deploying a router entry.

Public `secret.defaultModel` / `DEFAULT_MODEL` stay on the flagship. Staging
opts in with `DEFAULT_MODEL=claude-auto` **plus an explicit
`MEMORY_LLM_MODEL`** (see §2 — it inherits `DEFAULT_MODEL` otherwise). A task
can still pin `request.model=claude-opus-4-7`.

## 7. Client-visible actual model (required)

LiteLLM restamps the JSON `model` field back to the request alias unless
`return_raw_model_name: true`. The deployment string is always on
`x-litellm-model-name` (for example `anthropic/claude-haiku-4-5`).

Anthropic and OpenAI SDK `Stream` objects do **not** expose the Fetch
`Response`. Brain wraps the client's `fetch`, records that header, and also
reads `message.model` / chunk `model` as a fallback.

```
LiteLLM  x-litellm-model-name  (preferred)
         or body model when return_raw_model_name is true
  → anthropic-provider / openai-provider  LlmTurnResult.routedModel
    → agent-loop turnTokenStats.routed_model
      → AssistantMessage / ThinkingMessage  (session SSE)
```

Contract:

| Field | Meaning |
|-------|---------|
| `request.model` / `DEFAULT_MODEL` | Router alias, e.g. `claude-auto` |
| `routed_model` | Backend that served this turn, e.g. `claude-haiku-4-5` |

`resolveRoutedModel` deliberately does **not** fall back to the requested
model. If neither the header nor the stream body named a backend, the field is
absent rather than echoing the alias back — a `routed_model: claude-auto` would
be a lie exactly when a reader most needs to know the router did not answer.

- Additive. Old clients ignore unknown fields.
- `sanitizeSessionEvent` only redacts credentials; `routed_model` is kept.
- Text and thinking blocks already carry per-turn token stats; `routed_model`
  rides on the same events. **No new event type or shape is introduced.**
- A tool-only turn emits nothing. It has no text or thinking block, so the
  backend it used is not reported until the next turn that produces one.

That last point was twice the other way, and both attempts fired far wider
than intended, so it is worth writing down why there is no third:

- Gated on `routedModel` being set, it fired on every tool-only turn of every
  deployment — every upstream echoes a model back in the stream body.
- Gated on the model having come from `x-litellm-model-name`, it fired on
  every deployment behind LiteLLM. In v1.96.2 `get_custom_headers()` writes
  that header on every proxied response, taking the value from
  `litellm_params.metadata["deployment"]`, which the Router stamps for *any*
  `model_list` entry. Presence of the header says "LiteLLM served this", not
  "a router chose this".
- Comparing the served model against the requested one does not separate them
  either: a gateway that maps an alias to another backend — observed live,
  `claude-opus-4-7` served by `claude-opus-4-8` — differs on every turn.

There is no signal available that means "an Auto Router picked this backend",
so the extra event is gone rather than gated a third time. The cost of getting
it wrong is an extra content-less `AssistantMessage` per tool-only turn on the
wire, in `claw_session_events`, and in every history replay, delivered to a
client that has never seen that shape; the benefit is information the next
turn with text carries anyway.

- v1 does **not** change A2A / MCP wait / Anthropic-compatible stream
  mapping (those surfaces currently extract text only).

A known LiteLLM provider prefix (`anthropic/…`, `openai/…`, `hosted_vllm/…`)
is stripped before SSE. The list is closed rather than a pattern: matching
"anything that looks like a lowercase identifier" also matches a Hugging Face
org, which silently turned `Qwen/Qwen3-235B` into `Qwen3-235B` while leaving
`deepseek-ai/DeepSeek-V3` alone — same class of id, opposite result.

Compaction and the web_fetch summarizer are internal calls and do not get a
session `routed_model` event.

## 8. Out of scope

- Hands / Sandbox / API routers
- Brain per-turn model selection
- Changing public `secret.defaultModel`
- Hook semantics (only the image COPY path is regression-tested)
- Langfuse (Claw LLM observability is LiteLLM headers / SpendLogs)

## 9. Acceptance and rollback

- Simple turns land on Haiku; hard coding/planning on the flagship.
- `tool_use` + thinking do not fail because the backend changed mid-session.
- `cache_read_input_tokens` still hits on follow-up turns.
- web_fetch summaries still call Haiku, not the router.
- Classifier timeout/error does not 500 (heuristic or default flagship).
- Gateway logs remain greppable (`cause=`). SpendLogs show the actual model.
- Session SSE `routed_model` matches the gateway backend (not the alias),
  including tool-only turns.

Expected savings are about 15%–30% with quality-first pinning. Pure hard
reasoning sessions may save less.

Rollback: set `DEFAULT_MODEL` back to the flagship. Image rollback is only
needed if the v1.96.2 upgrade itself fails (hook path, UI `out` dir,
Anthropic Messages + router).

## 10. Risks

- 1.83 → 1.96 is a large jump: hook install path, UI static files, Messages
  API through the router.
- `STORE_MODEL_IN_DB=True`: UI/DB model rows must match the ConfigMap
  router and backends.
- Session pin lowers savings and raises stability. That is the intended v1
  trade.
- If a private values file omits `return_raw_model_name` **and** the fetch
  wrap misses the header, SSE falls back to the alias. Both are enabled in
  the example file and in Brain.
- Each router tier must be reachable on the same Anthropic Messages `api_base`
  Claw uses. A Vertex-only or undeployed MEDIUM (Sonnet) id 400s the entire
  `claude-auto` turn; probe SIMPLE / MEDIUM / COMPLEX with Messages before
  setting `DEFAULT_MODEL=claude-auto`. If a tier is missing, point it at a
  backend that exists rather than leaving a dead name in `complexity_router`.
