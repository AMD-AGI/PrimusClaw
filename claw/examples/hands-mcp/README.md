# Minimal demo: driving Hands over MCP

Runs one real component of the system end to end with nothing external attached.

Hands is the tool-execution layer — the MCP server that actually touches the
filesystem and runs commands on an agent's behalf. It is self-contained: its only
inputs are a workspace directory, a port and a shared token. That makes it the
part of PrimusClaw you can exercise without a Kubernetes cluster, a GPU, an LLM
API key, or any network egress.

```bash
cd claw && npm ci && npm run build   # once
./examples/hands-mcp/run.sh
```

`run.sh` creates a throwaway workspace, generates a random token, starts Hands on
a free port, waits for `/health`, and runs `demo.mjs` against it. Everything is
removed on exit, including on failure.

`demo.mjs` connects with `StreamableHTTPClientTransport` — the same client
transport Brain uses — so the demo exercises the real protocol path rather than a
simplified stand-in. It then:

- lists the advertised tools;
- writes a file and reads it back;
- edits a unique string, checking the rest of the file is untouched;
- confirms an ambiguous `old_string` is **refused** instead of silently changing
  the first of several matches;
- confirms `$&` and `$1` in a replacement are written literally rather than
  expanded as regex substitution patterns;
- searches with `grep`, `glob` and `ls`;
- runs a shell command;
- checks that a wrong bearer token is rejected.

The script exits non-zero if any check fails, so it doubles as a smoke test;
`make demo` from the repository root runs it, and CI runs it on changes to Hands.

## Notes

Paths are relative because Hands resolves every path against the workspace root.

Tool failures come back **in band**: the result is ordinary text starting with
`Error:` rather than a message with the MCP `isError` flag set. That is what the
agent reads, and the demo asserts on it accordingly.

The two S3 tools are the only ones needing outside configuration, so the demo
leaves them alone.
