# Contributing to PrimusClaw

Thank you for helping improve PrimusClaw. This guide covers the expected workflow, local setup, and quality checks.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing your contribution

PrimusClaw is MIT-licensed, except for `sandbox/`, which is an Apache-2.0 fork of
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox).
Contributions are accepted under the license of the tree you are changing —
inbound matches outbound. There is no separate CLA.

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). It is a one-line statement that you wrote the patch, or otherwise have
the right to submit it under the project's license. Sign off every commit:

```bash
git commit -s -m "fix: ..."
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must be real and must match your committer identity. To sign
off a branch you already wrote:

```bash
git rebase --signoff main
```

A pull request whose commits are not signed off cannot be merged. This applies
to every tree in the repository.

## Pull Request workflow
- Create a feature branch off `main`.
- Sign off every commit (`git commit -s`) — see [Licensing your contribution](#licensing-your-contribution).
- Keep changes focused and include context in the PR description (problem, approach, test coverage).
- Ensure merge requirements and applicable GitHub checks pass before requesting review (see [CI and documentation-only changes](#ci-and-documentation-only-changes)).
- Avoid committing generated artifacts; keep diffs minimal.

## CI and documentation-only changes

This repository treats **documentation-only** pushes and pull requests the same way across automation: when **every** changed file in that event matches **only** the [canonical paths-ignore list](#canonical-paths-ignore-list) below, matching GitHub Actions workflows **do not** start (no workflow run is created for that event).

### What is skipped today on GitHub Actions

| Check (concept) | Implemented in Actions | Skipped for doc-only events? |
|-----------------|------------------------|------------------------------|
| **Pytest** (full suite with coverage reporting) | [`.github/workflows/tests-coverage.yml`](.github/workflows/tests-coverage.yml) | Yes (`paths-ignore` on `push` / `pull_request` for all branches) |
| **CodeQL** | [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) | Yes on **PR and push** when doc-only (`paths-ignore`); **no** — the **weekly schedule** on the default branch still runs a full analysis |
| **Claw shell lint scripts** | [`.github/workflows/lint.yaml`](.github/workflows/lint.yaml) | Yes (`paths-ignore` on `push` / `pull_request` for all branches) |
| **Build** (container images on `main` / tags) | [`.github/workflows/build.yaml`](.github/workflows/build.yaml) | Yes on **push to `main`** when doc-only (`paths-ignore`); tag pushes use the same list |

If you add workflows for **pytest**, **ruff**, or similar, copy the **same** `paths-ignore` blocks as in `tests-coverage.yml` / `codeql.yml` / `lint.yaml` so documentation-only PRs stay consistent and cheap.

### Canonical paths-ignore list

Use this list (or keep it in sync) for any workflow that should skip on documentation-only changes:

- `**/*.md`
- `docs/**`
- `LICENSE*`
- `COPYRIGHT`
- `CODEOWNERS`
- `.gitattributes`

If **any** changed file falls **outside** these patterns (for example `.py`, `pyproject.toml`, or `.github/workflows/*.yml`), the workflows that declare this list run as usual.

These GitHub jobs are optional from a default merge-policy perspective; skipping them on doc-only PRs saves runner time. You should still run **local** `pytest` and Claw lint scripts when your edits are not purely cosmetic (for example, Markdown that embeds commands, code blocks, or configuration snippets).

## Development setup
- Python 3.10+ for the Python services (`requires-python = ">=3.10"`). CI runs
  the suites on 3.11.
- Node is pinned to **26** by `claw/.nvmrc`, which also declares `"node": ">=26"`
  in `package.json`. Node 26 is a Current release rather than an LTS, so it may
  not be in your distribution's repositories yet — `nvm install` from the
  `.nvmrc` is the shortest path. Go reads its version from `sandbox/go.mod`.
- Create and activate a virtual environment per Python component you are changing.
- Install Python package dependencies (extras differ per component):
  - `pip install -e "memory/memory-service/.[dev,storage]"` — the `storage`
    extra is not optional for running the tests; without it collection fails on
    missing `fastapi` / `asyncpg`
  - `pip install -e "memory/knowledge-worker/.[dev]"`
  - `pip install -e "sandbox/sdk-python/.[dev]"`
- Set up the Claw TypeScript monorepo (npm workspaces):
  - `cd claw && npm install`
  - `npm run build`
- Copy and edit environment templates before running services:
  - `cp claw/.env.example claw/.env`

## Testing

`make verify` from the repository root runs everything CI runs, so a green local
run should mean a green pull request. CodeQL is the only required check with no
local equivalent; the image builds and the dependency audits also have none.
Run `make help` for the individual targets; `make -k verify` reports every
failure instead of stopping at the first.

| Target | Covers |
|---|---|
| `make verify-claw` | `claw/` build, unit tests, and the hands-mcp example |
| `make verify-sandbox` | `sandbox/` `go build`, `go vet`, `go test` |
| `make verify-python` | the `memory/` pytest suites |
| `make verify-docs` | Sphinx build, warnings treated as errors |
| `make verify-lint` | repo lint scripts, gofmt, public tree scan, REUSE |

For a tighter loop, run the component directly:
- `pytest memory/memory-service/tests`
- `pytest memory/knowledge-worker/tests`
- `cd claw && npm test`
- `cd sandbox && make test`
- To target a single file or test name:
  - `pytest memory/memory-service/tests/test_handlers_scope.py -k subset`

### Coverage (source of truth)

**Authoritative coverage numbers** for this repository come only from the GitHub Actions workflow [`.github/workflows/tests-coverage.yml`](.github/workflows/tests-coverage.yml). Open the workflow run, then the **Summary** tab on the *Tests with Coverage* job: it reports a whole-repository total plus per-tree totals for `memory/memory-service` and `memory/knowledge-worker` (the same trees historically measured with multiple `--cov=` flags).

Do not treat ad hoc local `pytest --cov=...` invocations or any other workflow as the canonical headline metric unless that workflow is explicitly documented here. If you add a second CI job that prints coverage, keep it non-authoritative or remove it to avoid conflicting percentages.

Coverage is measured over **source only**: [`.coveragerc`](.coveragerc) omits test files, which are covered by the act of running them and would otherwise let the number climb by adding tests that assert nothing.

Three floors are enforced, and the build fails below any of them:

| Scope | Floor | Measured when set |
| --- | --- | --- |
| Combined (`--cov-fail-under`) | 54% | 55.8% |
| `memory/memory-service` | 45% | 46% |
| `memory/knowledge-worker` | 84% | 85% |

They are ratchets rather than targets: each sits just under the figure measured when it was introduced, so it catches regression without failing on the day it lands. Raise one when coverage improves. **Never lower one to turn a red build green** — that is the failure mode these are meant to prevent, and it converts the whole mechanism into decoration.

## Linting and formatting
- Ruff (where configured, e.g. knowledge-worker):
  - `ruff check memory/knowledge-worker`
- Claw TypeScript type checks:
  - `cd claw && npm run typecheck`
- Claw repo lint scripts (also enforced in CI):
  - `bash claw/scripts/lint-no-direct-hands-calltool-in-workspace.sh --all`
  - `bash claw/scripts/lint-metrics-must-register.sh --all`
  - `bash claw/scripts/lint-session-events-must-redact.sh --all`
  - `bash claw/scripts/lint-tenant-routes-must-authorize.sh --all`
  - `bash claw/scripts/lint-drain-shutdown-guard.sh --all`
  - `bash claw/scripts/lint-dockerfile-build-order.sh --all`
  - `bash claw/scripts/lint-no-nullish-env-default.sh --all`

## Before opening a PR
- [ ] Every commit is signed off (`git commit -s`).
- [ ] `make verify` passes, or at minimum the targets covering what you changed.
- [ ] Claw type checks pass (`cd claw && npm run typecheck`) if touching `claw/`.
- [ ] No unwanted files (build artifacts, large logs, credentials).
- [ ] No internal hostnames, endpoints, or key-shaped strings — `bash scripts/release-tests/public-tree-scan.sh` checks this and also runs in CI.

## Security
- Do not include secrets in code or logs.
- Report vulnerabilities privately as described in `SECURITY.md`.
