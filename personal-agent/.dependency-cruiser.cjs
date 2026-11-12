// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The layers of the personal agent, enforced in CI (`npm run depcruise`). Every rule is an error.
 *
 *   core     (@primusclaw/personal-agent)          channel-neutral domain: imports itself, zod, and -- from
 *                                                   src/protocol.ts alone -- the Claw wire contract.
 *   runtime  (@primusclaw/personal-agent-runtime)  Node adapters of core's ports: depends on core only.
 *   worker   (@primusclaw/personal-agent-runtime/worker, runtime's src/worker.ts and src/worker/)  the worker process
 *                                                   on any surface (the features behind the router, the store, HTTP,
 *                                                   metrics, timers): uses core and runtime's main entry, and no surface
 *                                                   and no npm package. A surface package plugs into it
 *                                                   (`SurfaceAdapter`). The rest of runtime never imports it.
 *   teams    (@primusclaw/personal-agent-teams)    the Teams surface: depends on core and runtime (and its worker).
 *   teams-ingress (@primusclaw/personal-agent-teams-ingress)  the Teams ingress Function: depends on core and on the
 *                                                   worker's Bot Connector host rule (teams' src/connector-hosts.ts
 *                                                   entry), never on the worker or the runtime.
 *   test-support                                    fakes for tests; never imported by a package's src.
 *
 * Every other package is a surface package (teams, a future slack, ...), together with its own helpers named after it
 * (teams-ingress is teams'). A surface package never imports another surface's package: Slack must not need Teams.
 *
 * The wire contract's own files (claw/packages/protocol/src) are compiled in but are not core's: what they import is
 * the contract's business, so the rules below judge the edges that start in this workspace.
 */
const PROTOCOL = "^\\.\\./claw/packages/protocol/src/";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle couples modules that should have one direction between them: any cycle, across directories and " +
        "packages, type-only imports included (tsPreCompilationDeps).",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-not-to-view",
      severity: "error",
      comment:
        "A view depends on its domain, never the other way: src/<area>/ must not import src/<area>-view/ of the same " +
        "package (core/src/remote -> core/src/remote-view is refused; remote-view -> remote is the allowed direction).",
      from: { path: "^packages/([^/]+)/src/([^/]+)/" },
      to: { path: "^packages/$1/src/$2-view/" },
    },
    {
      name: "core-is-channel-neutral",
      severity: "error",
      comment:
        "core imports only core, zod and the wire contract: no runtime, no channel, no Azure, Bot Framework, fastify, " +
        "node:sqlite, node:crypto, prom-client or any other Node built-in. A port or a plugin brings the rest.",
      from: { path: "^packages/core/src/" },
      to: { pathNot: ["^packages/core/src/", "^node_modules/zod/", PROTOCOL] },
    },
    {
      name: "protocol-only-through-protocol-ts",
      severity: "error",
      comment: "core/src/protocol.ts is the one file that reaches the Claw wire contract; everything else imports it.",
      from: { pathNot: "^packages/core/src/protocol\\.ts$|^packages/[^/]+/test/" },
      to: { path: PROTOCOL },
    },
    {
      name: "runtime-depends-on-core-only",
      severity: "error",
      comment: "runtime implements core's ports for Node; the worker and a channel depend on it, never the other way.",
      from: { path: "^packages/runtime/" },
      to: { path: "^packages/(?!core/|runtime/)[^/]+/" },
    },
    {
      name: "worker-is-surface-neutral",
      severity: "error",
      comment:
        "The worker (runtime's src/worker.ts and src/worker/) runs on whatever surface a surface package brings: it " +
        "imports core, runtime and Node built-ins, and no surface package (runtime-depends-on-core-only), Azure, Bot " +
        "Framework or other npm package of its own (a surface brings those).",
      from: { path: "^packages/runtime/src/worker(/|\\.ts$)" },
      to: { path: "^node_modules/" },
    },
    {
      name: "runtime-not-to-its-worker",
      severity: "error",
      comment:
        "runtime's main entry is the Node adapters alone: nothing of runtime but the worker itself imports the worker, " +
        "so a user of the adapters (and runtime's dist/index.js) never takes in the worker process.",
      from: { path: "^packages/runtime/", pathNot: "^packages/runtime/(src|test)/worker(/|\\.ts$)" },
      to: { path: "^packages/runtime/src/worker(/|\\.ts$)" },
    },
    {
      name: "surface-not-to-another-surface",
      severity: "error",
      comment:
        "A surface package (any package but core and runtime) uses core, runtime and runtime's worker, and its own helpers " +
        "named after it (teams-ingress is teams'), never another surface's: slack must not import teams.",
      from: { path: "^packages/(?!core/|runtime/)([^/-]+)[^/]*/" },
      to: { path: "^packages/(?!core/|runtime/|$1/|$1-)[^/]+/" },
    },
    {
      name: "teams-depends-on-core-and-runtime",
      severity: "error",
      comment: "teams uses core and runtime (and runtime's worker); it never reaches into its ingress Function.",
      from: { path: "^packages/teams/" },
      to: { path: "^packages/teams-ingress/" },
    },
    {
      name: "teams-ingress-depends-on-core-and-the-host-rule",
      severity: "error",
      comment:
        "The ingress Function loads core and the worker's Bot Connector host rule and nothing else of the workspace: " +
        "its deployable bundle must not take in the worker, the Teams surface or the runtime.",
      from: { path: "^packages/teams-ingress/src/" },
      to: { path: "^packages/(runtime|teams)/", pathNot: "^packages/teams/src/connector-hosts\\.ts$" },
    },
    {
      name: "packages-through-their-entry",
      severity: "error",
      comment:
        "Another package is used through its public entries (src/index.ts, runtime's src/worker.ts and teams' " +
        "src/connector-hosts.ts), never by a deep path into its files.",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/[^/]+/",
        pathNot: [
          "^packages/$1/",
          "^packages/[^/]+/src/index\\.ts$",
          "^packages/runtime/src/worker\\.ts$",
          "^packages/teams/src/connector-hosts\\.ts$",
        ],
      },
    },
    {
      name: "src-not-to-tests",
      severity: "error",
      comment: "Production code never imports test-support or a test.",
      from: { path: "^(packages/[^/]+/src|test-support)/" },
      to: {
        path: "(^test-support/|^packages/[^/]+/test/|\\.test\\.ts$)",
        pathNot: "^test-support/(?!.*\\.test\\.ts$)",
      },
    },
    {
      name: "src-not-to-test-support",
      severity: "error",
      comment: "A package's src never imports the shared test fakes.",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^test-support/" },
    },
    {
      name: "src-not-to-dev-dependencies",
      severity: "error",
      comment: "What a package's src imports must be one of its dependencies, not a development tool.",
      from: { path: "^packages/[^/]+/src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "not-to-undeclared",
      severity: "error",
      comment: "Every package imported is declared in a package.json.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "An import that does not resolve is a broken build waiting for its first run.",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // The wire contract is a leaf here: its own imports are not this workspace's edges.
    doNotFollow: { path: ["node_modules", "^\\.\\./claw/"] },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
