# PrimusClaw Python API reference

**Scope: the Python packages only.** This site covers `claw_memory`,
`knowledge_worker` and the `agent_sandbox` SDK — roughly the `memory/` tree and
`sandbox/sdk-python/`. It is not a guide to PrimusClaw as a whole.

The bulk of the system is TypeScript (the Claw harness under `claw/`) and Go
(the sandbox control plane under `sandbox/`). Those are documented in Markdown
next to the code — `claw/docs/` and `sandbox/docs/` — and the repository
`README.md` is the entry point for the architecture and the repository layout.

PrimusClaw itself is an LLM agent orchestration system: it runs autonomous
coding-agent sessions inside per-session sandboxes, with skill management,
long-term memory, and multi-engine executor support.

API reference pages are generated from Google-style docstrings via
[Sphinx](https://www.sphinx-doc.org/) and its `napoleon` extension.

```{toctree}
:maxdepth: 2
:caption: Contents

getting-started
api/index
```

## Indices

- {ref}`genindex`
- {ref}`modindex`
- {ref}`search`
