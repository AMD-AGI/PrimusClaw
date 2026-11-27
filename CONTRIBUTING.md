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
- If a coding agent helped, say in the PR description how much (see [Contributing with a coding agent](#contributing-with-a-coding-agent)).
- Ensure merge requirements and applicable GitHub checks pass before requesting review (see [CI and documentation-only changes](#ci-and-documentation-only-changes)).
- Avoid committing generated artifacts; keep diffs minimal.

## CI and documentation-only changes

This repository treats **documentation-only** pushes and pull requests cheaply: when **every** changed file matches **only** the [canonical paths-ignore list](#canonical-paths-ignore-list) below, expensive jobs do not run. How that skip is implemented depends on the check.

The coverage workflow is different from the others, because branch protection requires a check named `test` — the job in [`.github/workflows/tests-coverage.yml`](.github/workflows/tests-coverage.yml). Where a workflow skipped by `paths-ignore` never reports at all, and so blocks the merge on "Waiting for status to be reported", a job skipped by a conditional reports as success. That workflow therefore **always starts**, and a small `changes` job decides whether `test` runs at all: on a documentation-only change `test` is skipped, which satisfies the required check.

### What is skipped today on GitHub Actions

| Check (concept) | Implemented in Actions | Skipped for doc-only events? |
|-----------------|------------------------|------------------------------|
| **Pytest** (full suite with coverage reporting) | [`.github/workflows/tests-coverage.yml`](.github/workflows/tests-coverage.yml) | Yes — the `test` job is skipped by a conditional, which satisfies the required check |
| **CodeQL** | [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) | **No** on pull requests: the `main` ruleset requires CodeQL code scanning results, which a skipped workflow never reports. Yes on **push** to `main` / `deploy/**` when doc-only (`paths-ignore`); the **weekly schedule** on the default branch still runs a full analysis |
| **Claw shell lint scripts** | [`.github/workflows/lint.yaml`](.github/workflows/lint.yaml) | Yes (`paths-ignore` on `push` / `pull_request` for all branches) |
| **Build** (container images on `main` / tags) | [`.github/workflows/build.yaml`](.github/workflows/build.yaml) | Yes on **push to `main`** when doc-only (`paths-ignore`); tag pushes use the same list |

If you add workflows for **ruff** or similar that are **not** required status checks, copy the **same** `paths-ignore` blocks as in `lint.yaml`. Do not put `paths-ignore` on a workflow whose job name is required to merge, nor on the `pull_request` trigger of a workflow whose results a ruleset requires (CodeQL).

### Canonical paths-ignore list

Use this list (or keep it in sync) for any workflow that should skip on documentation-only changes. The coverage workflow's `changes` job applies the same patterns through [`.github/scripts/is_doc_only_change.sh`](.github/scripts/is_doc_only_change.sh):

- `**/*.md`
- `docs/**`
- `LICENSE*`
- `COPYRIGHT`
- `CODEOWNERS`
- `.gitattributes`

If **any** changed file falls **outside** these patterns (for example `.py`, `pyproject.toml`, or `.github/workflows/*.yml`), the workflows that declare this list run as usual.

Lint and image builds are optional from a merge-policy perspective; skipping them on doc-only PRs saves runner time. CodeQL is not optional: the `main` ruleset requires its code scanning results on every pull request. The coverage job named `test` is required, so it skips through a conditional rather than a path filter. You should still run **local** `pytest` and Claw lint scripts when your edits are not purely cosmetic (for example, Markdown that embeds commands, code blocks, or configuration snippets).

## Development setup
- Python 3.10+ for the Python packages (`requires-python = ">=3.10"`). CI runs
  the suites on 3.11.
- Node is pinned to **26** by `claw/.nvmrc`, which also declares `"node": ">=26"`
  in `package.json`. Node 26 is a Current release rather than an LTS, so it may
  not be in your distribution's repositories yet — `nvm install` from the
  `.nvmrc` is the shortest path. Go reads its version from `sandbox/go.mod`.
- Create and activate a virtual environment per Python component you are changing.
- Install Python package dependencies:
  - `pip install -e "sandbox/sdk-python/.[dev]"`
  - `pip install pytest pytest-cov coverage` for the Python unit suites
- Set up the Claw TypeScript monorepo (npm workspaces):
  - `cd claw && npm install`
  - `npm run build`
- Copy and edit environment templates before running services:
  - `cp claw/.env.example claw/.env`

## Testing

`make verify` from the repository root runs the Claw, Sandbox, Python, docs and
lint targets below. It does not run everything CI runs: there is no step for
`personal-agent/` (`npm run check`), `connector/` (`npm run typecheck && npm test`),
the Claw wire-type compile or `claw/scripts/lint-llm-settings-deployable.sh`.
[`AGENTS.md`](AGENTS.md) ("Before you push") lists what to run for each tree; run
what matches the trees you changed. CodeQL is the only required check with no
local equivalent; the image builds and the dependency audits also have none.
Run `make help` for the individual targets; `make -k verify` reports every
failure instead of stopping at the first.

| Target | Covers |
|---|---|
| `make verify-claw` | `claw/` build, unit tests, and the hands-mcp example |
| `make verify-sandbox` | `sandbox/` `go build`, `go vet`, `go test` |
| `make verify-python` | the Python unit suites (`deploy/litellm/tests`) |
| `make verify-docs` | Sphinx build, warnings treated as errors |
| `make verify-lint` | repo lint scripts, gofmt, public tree scan, REUSE |

For a tighter loop, run the component directly:
- `pytest deploy/litellm/tests`
- `cd claw && npm test`
- `cd personal-agent && npm run check`
- `cd connector && npm run typecheck && npm test`
- `cd sandbox && make test`
- To target a single file or test name:
  - `pytest deploy/litellm/tests/test_prompt_cache_hook.py -k ttl`
  - The single-file commands for the Claw, personal-agent and connector suites are in
    [`AGENTS.md`](AGENTS.md) ("Tests").

### Coverage (source of truth)

**Authoritative coverage numbers** for this repository come only from the GitHub Actions workflow [`.github/workflows/tests-coverage.yml`](.github/workflows/tests-coverage.yml). Open the workflow run, then the **Summary** tab on the *Tests with Coverage* job: it reports a whole-repository total plus a per-tree total for each tree the job runs (today `deploy/litellm`).

Do not treat ad hoc local `pytest --cov=...` invocations or any other workflow as the canonical headline metric unless that workflow is explicitly documented here. If you add a second CI job that prints coverage, keep it non-authoritative or remove it to avoid conflicting percentages.

Coverage is measured over **source only**: [`.coveragerc`](.coveragerc) omits test files, which are covered by the act of running them and would otherwise let the number climb by adding tests that assert nothing.

Two floors are enforced, and the build fails below either of them:

| Scope | Floor | Measured when set |
| --- | --- | --- |
| Combined (`--cov-fail-under`) | 92% | 93% |
| `deploy/litellm` | 92% | 93% |

They are ratchets rather than targets: each sits just under the figure measured when it was introduced, so it catches regression without failing on the day it lands. Raise one when coverage improves. **Never lower one to turn a red build green** — that is the failure mode these are meant to prevent, and it converts the whole mechanism into decoration.

## Linting and formatting
- Claw TypeScript type checks:
  - `cd claw && npm run typecheck`
- Claw repo lint scripts (also enforced in CI): `make verify-lint`. Each
  `claw/scripts/lint-*.sh` states the invariant it guards, and why, in its header.

## Before opening a PR
- [ ] Every commit is signed off (`git commit -s`).
- [ ] The checks of every tree you changed pass (see "Before you push" in [`AGENTS.md`](AGENTS.md)); `make verify` alone does not cover `personal-agent/` or `connector/`.
- [ ] No unwanted files (build artifacts, large logs, credentials).
- [ ] No internal hostnames, endpoints, or key-shaped strings — `bash scripts/release-tests/public-tree-scan.sh` checks this and also runs in CI.
- [ ] If a coding agent helped, the PR description says how much, and no commit carries a trailer naming an agent or tool.

## Contributing with a coding agent

You are the author of what you submit, and you sign the DCO yourself. An agent
never adds or invents a `Signed-off-by` for someone else, and a commit carries no
`Co-authored-by`, `Signed-off-by` or similar trailer that names an agent or a tool.
(GitHub adds a `Co-authored-by` for each human author when it merges a pull request
that has several; that is fine.) State in the pull request description how much an
agent assisted: for example that it drafted the change and you edited it, or that
you used it only to review.

Review every line before you open the pull request, run the checks for the trees
you changed, and keep the change focused. [`AGENTS.md`](AGENTS.md) is written for
coding agents and lists the checks and conventions they most often miss.

## Security
- Do not include secrets in code or logs.
- Report vulnerabilities privately as described in `SECURITY.md`.
