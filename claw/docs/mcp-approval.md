# MCP tool approval: `requires_approval` and `auto_approve`

Two fields on an MCP server spec (`mcpServers.<name>` in a tool config) decide
which of that server's tools wait for a person.

| Field | Effect |
|---|---|
| `requires_approval` | Holds tools for an explicit decision. `true` holds every tool; a list holds those names, and a trailing `*` matches a name prefix. |
| `auto_approve` | Of the held tools, lets an explicit, low-risk subset run without a decision. Absent means nothing is released, which is how every existing config behaves. |

Tool names are the server's own names, without the `mcp__<server>__` prefix the
model sees. `camelCase` spellings (`requiresApproval`, `autoApprove`) are read too.

## `auto_approve`

A list of entries. An entry is a tool name (trailing `*` matches a prefix), or
an object with a `tool` and an optional `when`:

```json
{
  "mcpServers": {
    "ops": {
      "url": "https://mcp.example.invalid/mcp",
      "requires_approval": true,
      "auto_approve": [
        "get_*",
        "job_requeue",
        { "tool": "plan_set_status", "when": { "status": "paused" } }
      ]
    }
  }
}
```

- It narrows a hold, never creates one. It matters only to a call that
  `requires_approval` already holds; a held tool that is not listed still asks a
  person, and is denied when nobody answers or no approval channel exists.
- A listed call runs at once, with no approval card, even in a session nobody is
  watching. It is recorded as a `decisionResult` with `by: "policy"` and counted
  in `claw_hitl_policy_allow_total`. The counter has no labels, because a request
  can carry its own server spec and a label per server or entry would be a series
  per request; the entry that released the call is the `rule` field of the
  `hitl.policy_allow` log line.
- `when` compares the call's top-level arguments with strict equality: each value
  must be a string, number, boolean or `null`, and every listed key must be present
  and equal. A nested argument cannot be matched, so a tool whose risk sits inside
  a nested argument should not rely on `when`; check it on the server.
- `when` constrains only the keys it names. Any other argument the call carries is
  not checked: with `{ "tool": "plan_set_status", "when": { "status": "paused" } }`
  the call `{ "status": "paused", "plan_id": "*", "cascade": true }` is released
  too. Name every argument that matters in `when`, or do not list the tool.
- A `null`, a bare `*`, a bare `true`, an empty list, an unknown key in an entry, or
  an empty or non-scalar `when` is malformed (only an absent field means no rule). A malformed `auto_approve` fails closed: the
  whole field is ignored, so nothing of that server is released, and
  `approval_policy.invalid_auto_approve_ignored` is logged. One bad entry voids the
  list.
- If both spellings are present, a call is released only when both list it.
- A per-call hold (the bash approval rules) is never lifted by `auto_approve`.

This is a convenience for unattended sessions, not an authorization boundary.
Keep server-side authorization as the real control, and list only tools whose
effect is cheap and reversible.

## Offering a subset: `enabled_tools` and `disabled_tools`

Two more fields on the same server spec decide which of the server's tools the
model is offered at all (`src/clients/mcp-tool-filter.ts`). Every offered tool's
schema is sent on every model call, so a server with dozens of tools costs that
much prompt on every turn; these fields cut it per server.

| Field | Effect |
|---|---|
| `enabled_tools` | Only these tools are offered. |
| `disabled_tools` | These tools are not offered, whatever `enabled_tools` says. |

Names and patterns work as for `requires_approval`: the server's own names, a
trailing `*` matches a prefix, and a bare `*` matches every tool. `camelCase`
spellings are read too; with both spellings present a tool must pass both.

```json
{
  "mcpServers": {
    "ops": {
      "url": "https://mcp.example.invalid/mcp",
      "enabled_tools": ["get_*", "preview_*", "job_requeue"],
      "disabled_tools": ["get_audit"]
    }
  }
}
```

- Absent fields offer every tool, as before.
- A tool that is not offered cannot be called either: the client refuses the
  call and the server never sees it.
- A field that is present but cannot be read (not a list, an empty list, an
  entry that is not a non-empty string, `null`) keeps the whole server out of
  the run. It is reported like a server that is down (the `mcp_unavailable`
  progress event and the note to the model), with the field named.
- A name the server does not list is logged as
  `mcp_client.tool_filter_names_unknown`, so a typo or a renamed tool is visible.
- It is a prompt-size control, not an authorization boundary: a tool that must
  never run belongs off the server or behind `requires_approval`.
