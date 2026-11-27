# AGENTS.md

PrimusClaw is one repository with four product trees: `claw/` (the server: API, Brain and Hands over NATS and Postgres),
`connector/` (puts a developer's own coding agents behind Claw), `personal-agent/` (the chat assistant that works through
Claw; Microsoft Teams is the first surface) and `sandbox/` (a Go fork of kubernetes-sigs/agent-sandbox, Apache-2.0).
`deploy/` (the whole-stack installer and the LiteLLM wrapper, in Python) and `docs/` (the Sphinx site for the Python
packages) sit beside them. Read the README of the tree you change; this file holds only what the READMEs and the code do
not say, and `CONTRIBUTING.md` has the DCO and the pull request workflow. Before you design or review a change, read
`ENGINEERING.md`: architecture principles, design rules, the definition of done and the review bar, each with the file
that enforces it.

## Before you push

`make verify` from the repository root is the quick check, but it is not everything CI runs: it has no personal-agent,
connector, wire-type or LLM-settings step, and CodeQL has no local equivalent. Run what matches the trees you changed.
CI tests on Node 26 (`claw/.nvmrc`). `connector/` declares Node >=22, so use no Node 23+ API there.

- Any change, from the root: `bash scripts/release-tests/public-tree-scan.sh` (needs ripgrep with PCRE2); after committing,
  `bash scripts/release-tests/public-message-scan.sh origin/main..HEAD`.
- `claw/`:

  ```bash
  cd claw
  npm ci && npm run build && npm run typecheck && npm test
  bash scripts/lint-tests-must-resolve.sh --all
  bash scripts/lint-llm-settings-deployable.sh
  npx --no-install tsc -p packages/protocol/tsconfig.wire-test.json
  ```

  Then, from the root, `make verify-lint` runs the other `claw/scripts/lint-*.sh` guards, gofmt and REUSE (needs Go, ripgrep and
  `pip install reuse`).
- `personal-agent/` (about 10 minutes; typecheck, ESLint, Prettier, dependency-cruiser, coverage floors, ported tests):

  ```bash
  cd personal-agent
  pip install -r test-support/python/requirements.txt
  npm ci && npm run check
  npm run build && npm run check-pack   # only if you touch packaging
  ```
- `connector/` (needs tmux):

  ```bash
  cd connector
  npm ci && npm run typecheck && npm test
  npm run build && node scripts/check-pack.mjs
  ```
- `sandbox/`, unit tests only (the e2e suites need a cluster): `cd sandbox && make all && make fmt-verify`.
- `deploy/litellm` and `docs/`, from the root: `make verify-python` (needs `pip install pytest pytest-cov coverage`) and
  `make verify-docs` (needs `pip install -r docs/requirements.txt`).

## Boundaries

- Claw's build order, and why it matters, is in `claw/README.md` ("Workspaces"); `claw/Dockerfile` must follow it
  (`lint-dockerfile-build-order.sh`). `api` and `brain` never import each other: they meet over NATS and `@claw/protocol`.
- `claw/packages/protocol` is the contract the other trees compile in: `personal-agent/packages/core/src/protocol.ts` and
  `connector/src/protocol.ts` are the only files there that import it. A protocol change breaks their typecheck, which
  the `claw/` tests do not run, so run all three trees.
- "Router" means three things: the Claw assistant's router turn (`claw/packages/api/src/assistant/`), personal-agent
  message routing (`personal-agent/packages/core/src/routing/`) and the Sandbox Router (`sandbox/pkg/router`).
- Database DDL is idempotent and runs on every API start, from `initDb` in `claw/packages/api/src/infra/db.ts`: the core
  tables are there, and `initDb` calls each feature's own schema module (`assistant/schema.ts`, `remote-agents/schema.ts`,
  ...) when the feature is enabled. What the code then depends on is added to `schema-guard.ts` beside `initDb`.

## Tests

- Claw suites are `node:test` under `claw/packages/*/test/`, run through `tsx`. A package's tests must sit flat as
  `test/*.test.ts`: its `test` script globs exactly that, CI fails if the script changes, and a file in a subdirectory never
  runs. The connector's `test/*.test.ts` is flat too; personal-agent's glob is recursive. Package `tsconfig`s include `src`
  only, so `npm run typecheck` never sees a test (`lint-tests-must-resolve.sh` catches unresolved names). The scripts in
  `claw/tests/` need a deployed stack.
- One test file, after `npm ci` in that tree (replace `<name>` with the file's name):

  ```bash
  (cd claw/packages/api && npx --no-install tsx --test test/<name>.test.ts)    # or brain, hands, protocol, utils
  (cd personal-agent && node --import tsx --test packages/core/test/<name>.test.ts)
  (cd connector && npx --no-install tsx --test test/<name>.test.ts)
  ```
- Many api tests need Postgres. Without `DATABASE_URL` they skip with "DATABASE_URL is not set" and the summary can still
  print `skipped 0`: a skip is not a pass. CI uses `postgres:16` with
  `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`. The rolling-restart chaos suite also needs a pinned
  nats-server; see the `claw-rolling-restart` job in `.github/workflows/tests.yml`.
- A regression test must fail when its fix is reverted: revert it once and look. A measurement that skips or errors exits
  non-zero. Wait on a condition, not a fixed sleep. A test that changes shared state (DDL, advisory locks, sockets, TMPDIR)
  scopes it to its own database or name and restores it in `finally`.

## Personal agent

- The bot's earlier default name may appear in `personal-agent/packages/*/src` only in `LEGACY_` or `PERSISTED_` constants,
  comments and examples included (`personal-agent/test/legacy-names.test.ts`). Take the bot's name from configuration.
- A change to name stripping, addressing or typed commands is tested for a 1:1 chat attached to a coding agent, a 1:1 chat
  not attached, a group and a mistyped command.

## The Claw assistant and its prompts

- Prompt text lives in `claw/packages/api/src/assistant/prompts.ts` (also `self-status.ts`, `writing-prompt.ts`,
  `proactive-prompt.ts`) as constants with a `*_PROMPT_VERSION`. Changing a section's text bumps its version, adds a dated
  line to the header comment naming the real case behind it, and updates the version the tests pin
  (`rg -l ROUTER_PROMPT_VERSION claw/packages/api/test`).
- Router tools are cut to `mcp__assistant__*` and only `say` reaches the user; `say` refuses internal text
  (`internal-text.ts`), the wrong language and over-long text. Which tools read and which write comes from one catalog,
  `claw/packages/protocol/src/mcp-tool-catalog.ts`; do not keep a second list.

## What blocks a review

The full list is `ENGINEERING.md` section 4. A finding blocks when it is a defect on the normal path or is exploitable:

- a regression, crash, hang or wrong result on the normal path, also behind a shipped flag or documented setting, or from
  a new branch wider than its case;
- a security flaw: a missing owner check, a secret in a log or event, untrusted text that can act, an approval nobody gave;
- a guard, validator, fake or test that disagrees with the real consumer (fix the class, not the instance);
- a retry, stop, restart, failed or concurrent write, or migration that drops the user's explicit choice or a parameter,
  or carries stale state;
- a data write that is not transaction-safe, or one code for "refused" and "unknown";
- a claim the code does not keep in a line the change adds or changes: a test that cannot fail, an "only", "never" or "no"
  the code contradicts, a setting no deployment can write;
- an incompatible change not called out; a side effect nobody told the user about.

An edge case with no reachable path, a name or a wording is recorded in the pull request and does not block.

## Public repository

- Everything committed is public. `scripts/release-tests/forbidden-strings.sh` lists what the scans reject: internal
  hostnames and storage paths, cluster DNS suffixes, key-shaped strings (a key-shaped fixture must contain `EXAMPLE`). The
  scans cover every tracked file, Markdown included, and commit messages and author identities. They catch only what they
  list: also keep out real people's names and email addresses (use `user@example.com`), internal ticket or chat links,
  service-account names and absolute paths from your machine. Never commit a secret or put a token in a remote URL.
- CodeQL is required and scans test code: no unused locals, assert whole strings rather than `includes` on URL-shaped
  fixtures, build a RegExp only from escaped literals.
- By convention a new source file starts with the two-line SPDX header its neighbours carry (MIT; Apache-2.0 under
  `sandbox/`, a fork whose provenance is in `sandbox/UPSTREAM.md`). `REUSE.toml` already licenses every path, so no check
  fails when it is missing.

## Commits and pull requests

- `git commit -s` with your own real name and email. Never add or invent a `Signed-off-by` for someone else, and add no
  `Co-authored-by`, `Signed-off-by` or similar trailer that names an agent or a tool: the person who submits the change is
  its author.
- Subject `type(scope): what changed`, for example `fix(connector): report a conversation that just ended`; the scope is the
  tree or package (`claw`, `connector`, `personal-agent`, `sandbox`, or a package such as `brain`, comma-separated for
  several) and the squash merge adds `(#N)`. One change per pull request, except that changes to claw, personal-agent and
  connector that must land together go in one: PR #949 is a worked example, with its tests and changelog lines. Fill in
  `.github/PULL_REQUEST_TEMPLATE.md`.
- Call out in the pull request description a new dependency, a schema change, a Helm value or an export of a published
  package, with the reason. A change under `.github/workflows/` or to `.github/CODEOWNERS` needs a maintainer's review.
  Never lower a coverage floor, or add `paths-ignore` to a required check, to turn a build green.

Claw design notes are indexed in `claw/docs/README.md`; where a note and the code disagree, the code wins. Cite only
documents you can open (that index lists the ones source comments cite but the repository lacks).
