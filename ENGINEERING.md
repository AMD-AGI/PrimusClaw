# Engineering principles

The bar a change meets here, whoever or whatever writes it. It covers `claw/`, `connector/` and `personal-agent/`;
`sandbox/` (Go) and `deploy/` are covered only by their own READMEs (`sandbox/README.md`, `deploy/README.md`). Each rule
names what holds it in place:

- [CI] a check fails when the rule is broken. A red check is not necessarily a merge gate: the ruleset on `main`
  requires only the `test` check, CodeQL code scanning results, one code-owner review and resolved review threads. A
  change is still done only when every check is green (3.7).
- [test] a named test pins the rule.
- [review] reviewers apply it, and so must the author. A rule that carries only this tag has nothing else holding it.

What to run before pushing is in `AGENTS.md`; the DCO and the pull request workflow are in `CONTRIBUTING.md`; the version
numbers are defined in `CHANGELOG.md` ("Versioning").

## 1. Architecture

1. **Dependencies point one way.** Claw builds `utils -> protocol -> {hands, brain, api}`. `api` and `brain` never
   import each other (they meet over NATS and `@claw/protocol`), and `hands`, which runs in the sandbox, opens no NATS
   or database connection. In the personal agent, `core` imports no runtime, channel or Node built-in, and a surface
   never imports another surface. [CI] build order: `claw/scripts/lint-dockerfile-build-order.sh`; personal agent:
   `personal-agent/.dependency-cruiser.cjs` (`npm run depcruise`). [review] the `api`/`brain`/`hands` import rules
   (no check yet). See `claw/README.md` (Workspaces) and `personal-agent/README.md` (Layering).
2. **A lower layer does not know its consumers.** No branch on, or state kept for, a particular caller. Names on an
   interface describe the capability, never the consumer. Before adding a contract item, ask whether a second,
   unrelated consumer would need it; if not, the consumer that needs it absorbs it. The platform treats consumer input
   as opaque. [review]
3. **The protocol is the only shared contract.** `claw/packages/protocol/src` is compiled into the personal agent and
   the connector, never copied, and each reaches it through one file. A renamed field fails their typecheck, which the
   `claw/` tests do not run: run all three trees. [CI] rule `protocol-only-through-protocol-ts` in
   `personal-agent/.dependency-cruiser.cjs`; the "Wire types compile against the API" step of
   `.github/workflows/tests.yml` (`claw/packages/protocol/tsconfig.wire-test.json`,
   `claw/packages/protocol/test/claw-api-wire.test.ts`). [test] `connector/test/protocol-source.test.ts`.
4. **A rule that protects the user is enforced where the effect happens, not in the prompt.** Confirmation, read-only
   and "only this one" live in the tool or server that performs the effect; prompt text only describes them. The policy
   is re-checked at the moment of the effect, under the lock that serialises its writers, not only when the request was
   made. A model's reading of a sentence never grants an approval. [test]
   `claw/packages/api/test/github-review-guards.test.ts`, `claw/packages/api/test/assistant-say-guard.test.ts`,
   `claw/packages/brain/test/mcp-approval-policy.test.ts`. [review] the re-check under the lock. Illustrated by
   `claw/docs/github-review.md` ("Every gate is in the tool, not in the prompt") and the header of
   `claw/packages/api/src/assistant/prompts.ts`.
5. **Every read and write is scoped to its owner.** Authentication is one global hook; ownership is checked inside each
   handler or store function. A session or task that is not yours is refused with 403 `access_denied` (an id that does
   not exist is 404); a row of the remote-agents store that is not yours is simply not found (404). A read-only admin
   may read a tenant's session by design (`canAccessSessionAsOperator`) and may not change it. [CI]
   `claw/scripts/lint-tenant-routes-must-authorize.sh` (session, task and task-dag routes). [test]
   `claw/packages/api/test/routes-authz.test.ts`, `claw/packages/api/test/auth-anonymous-paths.test.ts` (the anonymous
   paths are an explicit list). [review] every other namespace; see the owner in each WHERE of
   `claw/packages/api/src/remote-agents/store.ts`. Posture: `SECURITY.md`.
6. **Fail closed, and tell "could not look" from "nothing wrong".** A malformed rule, or a preference, opt-out or
   restriction that cannot be read or written, keeps the restriction; an error path never returns what a clean
   negative returns. [CI] `claw/scripts/lint-startup-calls-rollout-assert.sh` (bad rollout settings stop start-up).
   [review] the rest. Illustrated by `claw/docs/mcp-approval.md`, `claw/docs/bash-approval.md` (malformed rules),
   `connector/README.md` ("What the connector enforces") and `claw/packages/api/src/infra/schema-guard.ts`.
7. **Text written by an agent, a machine or another person is data.** Render it inert, never let it decide an action,
   and keep it out of trusted prompt context unless the turn is marked as having read untrusted text. [test]
   `claw/packages/api/test/assistant-devenv.test.ts`. Code: `claw/packages/api/src/assistant/inert-md.ts`,
   `markUntrustedRead` in `claw/packages/api/src/assistant/inbound.ts`; `claw/docs/github-review.md` (text from the pull
   request is `untrusted`). What an agent read or ran lands in session events: [CI]
   `claw/scripts/lint-session-events-must-redact.sh` (a route that reads them redacts them). Its other half: a
   checkpoint, which a resumed run replays to the model, is sealed and never redacted. [CI]
   `claw/scripts/lint-checkpoint-must-seal.sh`.
8. **Every path that moves a message, event, notice or answer says what happens on a transient failure, a shutdown, a
   redelivery and a rolling deploy.** Drop or quarantine only on a proven-permanent signal. [CI] the shutdown handler
   guards re-entry on the shutdown latch alone: `claw/scripts/lint-drain-shutdown-guard.sh`. [test]
   `claw/packages/api/test/rolling-restart-chaos.test.ts` (CI job "Claw rolling restart (chaos)"). [review] every other
   path. See `claw/docs/architecture-design.md` (6.4 Interrupts and drain; 8 Concurrency, timing and recovery).
9. **One rule, one place.** When a view, list, check, validator or test double repeats a rule that lives elsewhere,
   import the real function, or add a test that runs both on the same fixtures; derive a list from the closed set it
   covers. Example: which MCP tools read and which write comes from one catalog,
   `claw/packages/protocol/src/mcp-tool-catalog.ts`, pinned by `claw/packages/api/test/tool-classes.test.ts`. [review]
10. **A rule with no exceptions becomes a guard, not a paragraph.** [CI] the guards in `claw/scripts/lint-*.sh`, each
    with its invariant and the failure that made it necessary in its header.

## 2. Design rules

- **The simplest design that works.** Start from the existing objects; add the fewest fields and steps that close the
  loop; use an existing component or a standard interface before a custom one; name things as users already do; add no
  concept a second consumer would not need. State measured facts as facts and label the rest as assumptions. [review]
  Illustrated by `personal-agent/docs/adding-a-surface.md`: a new surface implements the interfaces that exist.
- **What the repo ships is what it tests.** A default, a setting or a convenience that the repository publishes has an
  owner and a test that keeps running, or it is not added. A deployment's own integrations (identity, a model gateway's
  rules, extra routes, feedback) stay outside the repository behind the plugin interfaces, and the public build runs
  with the neutral defaults (`personal-agent/README.md`, Layering): test the interfaces and those defaults here. [review]
- **Compatibility is named and tested.** Say which oldest peer (Claw, connector) and which stored-row shape the change
  must still serve, and test against it: `CONNECTOR_VERSIONS` in `claw/packages/protocol/src/remote-agents.ts`,
  `claw/docs/remote-agents.md` ("Connector versions and setup"). Schema changes are idempotent DDL at start, and what
  the code then depends on is listed in `claw/packages/api/src/infra/schema-guard.ts`. [review]
- **No silent shim.** A deprecated alias (an old setting name, field or route kept so that a change need not be called
  incompatible) is allowed only with a removal version stated beside it and a warning at start-up that names its
  replacement. Without both, document the change in the CHANGELOG as incompatible instead. [review]
- **Version numbers are the maintainers' call.** Before 1.0: PATCH by default; MINOR only for a big feature or an
  incompatible change, which includes the connector protocol, the personal agent's plugin ports and any export of a
  published package (`CHANGELOG.md`, "Versioning"). Say in the pull request when your change is incompatible; do not
  bump a version or cut a tag.
- **A retry, stop or restart keeps what it should and drops what it should.** For each path that enters work again
  (retry, stop, restart, resume, redelivery), list the state it carries over and the parameters it must carry, and test
  that none is lost and none is stale: the options the user gave, the run's own limits, the owner. [review]
- **A migration keeps what the user already chose.** A schema change or backfill never replaces an earlier explicit
  choice with a default, and it runs on rows that already break the new rule, such as duplicates under a new unique
  index, without stopping start-up. Test it against a database that holds such rows. [review]
- **A new branch is no wider than its case.** A new condition, pattern, catch or WHERE clause matches the case it
  targets and nothing else; test the nearest case it must leave alone. [review]
- **Configuration reaches the deployment.** A setting the code reads can be written by a deployment (chart, values,
  installer, upgrade), and a blank value takes the default. [CI] `claw/scripts/lint-llm-settings-deployable.sh` (the
  brain's `LLM_*` and `PROMPT_CACHE_*` settings reach the chart), `claw/scripts/lint-no-nullish-env-default.sh`
  (`process.env.X ?? default` is forbidden; use `||`). [review] every other setting: `claw/deploy/charts/claw/` and
  `claw/deploy/upgrade.sh`.

## 3. Definition of done

1. **A test that fails first.** The regression test fails with the fix reverted: revert it once and look. Pin
   boundaries with literals, not constants derived from the code under test; assert which check refused, not only that
   something did; wait on a condition, not a fixed sleep. A skipped test is not a pass (Postgres suites skip without
   `DATABASE_URL`; see "Tests" in `AGENTS.md`). A coverage floor is never lowered to turn a build green
   (`CONTRIBUTING.md`, "Coverage"; `personal-agent/scripts/coverage.ts`). [CI] the floors, and
   `claw/scripts/lint-tests-must-resolve.sh` (a test whose names do not resolve). [review] the rest.
2. **The path production takes.** Test through the entry point production uses, not an internal helper. Before moving a
   working flow onto a new path, list what each party (requester, assignee, group) sees today, run each on the new
   path, and keep the old path until they match. [review]
3. **Code gates.** Personal agent: strict TypeScript with `noUncheckedIndexedAccess`, complexity <= 15, <= 80 lines per
   function, <= 600 per file, no `any`, no disabling of those rules, no warnings. [CI]
   `personal-agent/eslint.config.js`.
   Claw: `npm run typecheck` and the lint scripts. [CI] `make verify-lint`, `.github/workflows/lint.yaml`.
4. **Both languages, in the personal agent.** Every string a user reads is a `defineCatalog({ en, zh })` entry, chosen by
   the recipient's language, never the requester's, the group's or an item title's. A string in one language only, or
   written inline, is not done. The compiler checks that both languages have the same keys and parameters; that a string
   goes through a catalog at all is [review]. Mechanism: `personal-agent/packages/core/src/locales/catalog.ts` and
   `personal-agent/packages/core/test/locales.test.ts`. The Claw assistant has no catalog: it reads the language to answer
   in from the user's own wording (Chinese, Japanese, Korean or English; an explicit `zh` or `en` choice made in the
   channel wins), and `say` refuses an answer that is plainly in another language:
   `claw/packages/api/src/assistant/language.ts`, `claw/packages/api/test/assistant-language.test.ts`,
   `claw/packages/api/test/assistant-router-quality.test.ts`.
5. **Docs and CHANGELOG.** A user-visible change adds a line under the Unreleased section of `CHANGELOG.md` (Claw,
   connector) or `personal-agent/CHANGELOG.md`, saying only what the code does unconditionally and the oldest peer
   version it needs. A design note changes in the same pull request as the behaviour it describes; where they
   disagree, the code wins (`claw/docs/README.md`). [review]
6. **Real-path verification, described in the pull request.** "Testing" in `.github/PULL_REQUEST_TEMPLATE.md` lists
   the commands, the environment and the results of the path users take, not only unit tests. Write "could not
   verify" for what did not run, and say which database tests ran and where. In the lines you add or change, every
   "only", "never" and "no", in a comment or in the description, is true and tested, or removed. [review]
7. **CI green, CodeQL included.** Every check green and none pending, no unresolved review thread, no conflict with
   `main`. CodeQL results are required on every pull request, so its `pull_request` trigger takes no `paths-ignore`; only
   its push trigger has one (`CONTRIBUTING.md`, `.github/workflows/codeql.yml`). [CI]
8. **No secrets in fixtures or events; nothing internal committed.** [CI] `.github/workflows/public-tree-scan.yaml`
   (`scripts/release-tests/forbidden-strings.sh`: internal names and key-shaped strings in the tree, commit messages
   and author identities) and the two session-event guards in 1.7. Nothing scans log output for secrets: [review] what a
   log line, an error message or an event can carry. What else stays out of a public repository: "Public repository" in
   `AGENTS.md`.

## 4. The review bar

The default instructions of Claw's pull request reviewer are public (`claw/packages/api/src/github-review/default-skill.ts`;
the standard text is also `claw/examples/skills/pr-review/SKILL.md`). They keep a finding only when this change introduces
it, the author knows what to change, and it is verified with a path and a line, and they drop style, naming, formatting
and anything a linter owns. The deep review in the same file adds that a problem that breaks the main path once a shipped
flag or documented setting is turned on is blocking even when the flag is off by default: off by default lowers the
urgency, not the severity. The classes below are what this repository's maintainers hold a change for; they are not that
text. A finding **blocks** when it is a defect on the normal path or is exploitable:

- a regression, crash, hang or wrong result on the normal path, also when a shipped flag or documented setting turns
  it on, or when a new branch or condition is wider than the case it targets;
- a security flaw: a missing owner check, a secret in a log or event, untrusted text that can act, an approval nobody
  gave;
- a guard, validator, fake or test that disagrees with the real consumer, so that something which should fail passes
  (case folding, same-name checks); fix the class, not the instance: list the sibling paths and give each a test;
- a failure that drops the user's explicit choice: an unreadable setting, a failed write or a concurrent write keeps
  the earlier choice and never falls back to the default; so does a retry, stop or restart that loses a parameter or
  carries stale state, and a migration that overwrites an earlier choice or stops on rows that break a new unique index;
- a data write that is not transaction-safe, or a state machine that reads two situations as one (one code for
  "refused" and for "unknown");
- a claim the code does not keep, in a line the change adds or changes (3.6): a test that cannot fail, a comment or
  description that says "only", "never" or "no" and is contradicted, or a setting the code reads that no deployment can
  write;
- an incompatible change that is not called out, a peer version the change should still serve but breaks, or a
  CHANGELOG conflict with `main`;
- a side effect nobody told the user about.

An edge case with no reachable path, a name or a wording is recorded in the pull request as a known limit and does
not block.
