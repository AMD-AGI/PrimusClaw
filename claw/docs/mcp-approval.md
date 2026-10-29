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
  in `claw_hitl_policy_allow_total{tool}`.
- `when` compares the call's top-level arguments with strict equality: each value
  must be a string, number, boolean or `null`, and every listed key must be present
  and equal. A nested argument cannot be matched, so a tool whose risk sits inside
  a nested argument should not rely on `when`; check it on the server.
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
