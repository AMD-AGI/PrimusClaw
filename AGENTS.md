# AGENTS.md

PrimusClaw is one repository with four product trees: `claw/` (the server: API, Brain and Hands over NATS and Postgres),
`connector/` (puts a developer's own coding agents behind Claw), `personal-agent/` (the chat assistant that works through
Claw; Microsoft Teams is the first surface) and `sandbox/` (a Go fork of kubernetes-sigs/agent-sandbox, Apache-2.0).
`deploy/` (the whole-stack installer and the LiteLLM wrapper, in Python) and `docs/` (the Sphinx site for the Python
packages) sit beside them. Read the README of the tree you change; this file holds only what the READMEs and the code do
not say, and `CONTRIBUTING.md` has the DCO and the pull request workflow.

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
- Database DDL lives in `claw/packages/api/src/infra/db.ts` and runs idempotently on every API start; what the code then
  depends on is added to `schema-guard.ts` beside it.

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

## Rules the guards and reviewers enforce

- Each `claw/scripts/lint-*.sh` states its invariant and why in its header; read it before editing near it. Examples:
  workspace code calls Hands only through the timeout wrapper; every prom-client metric registers; a route on a tenant's
  sessions or tasks authorizes inside its handler; `process.env.X ?? default` is forbidden, use `||`; every brain `LLM_*`
  setting reaches the chart.
- A rule that protects the user (confirmation, read-only, "only this seat") is enforced in the tool or server that
  performs the effect; prompt text only describes it. Re-check a policy at the moment of the effect, under the lock that
  serialises its writers, not only when the request or card was made.
- A preference, opt-out or restriction that cannot be read or written keeps the restriction; never default to on or
  unrestricted.
- Every path that moves a user message, event, notice or answer states and tests what happens on transient failure,
  shutdown, redelivery and a rolling deploy. Drop or quarantine only on a proven-permanent signal.
- When a view, list, check or test double repeats a rule that lives elsewhere, import the real function, or add a test that
  runs both on the same fixtures.
- Text written by an agent, a machine, a forwarded message or another user is data: render it inert
  (`claw/packages/api/src/assistant/inert-md.ts`) and keep it out of router prompts unless the turn is marked untrusted
  (`markUntrustedRead` in `assistant/inbound.ts`).
- Every user-visible string is a `defineCatalog({ en, zh })` entry in `personal-agent/packages/core/src/locales/` and is
  chosen by the recipient's language, never the requester's, the group's or an item title's.
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

## Compatibility and releases

- Name the oldest Claw, connector and stored-row shape your change must still serve (`CONNECTOR_VERSIONS.minimum` in
  `claw/packages/protocol/src/remote-agents.ts`) and test against it.
- Every user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md` (Claw, connector) or
  `personal-agent/CHANGELOG.md`. State only what the code does unconditionally, and name the minimum peer version.
- Before 1.0, changing an exported type, port or protocol field is incompatible and needs a MINOR ("Versioning" in
  `CHANGELOG.md`). Say so in the pull request; leave version bumps and tags to the maintainers.

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
  its author. If an agent wrote or substantially edited it, say how much in the pull request description.
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
