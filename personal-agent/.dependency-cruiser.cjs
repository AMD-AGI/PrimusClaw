// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The layers of the personal agent, enforced in CI (`npm run depcruise`). Every rule is an error.
 *
 *   core     (@primusclaw/personal-agent)          channel-neutral domain: imports itself, zod, and -- from
 *                                                   src/protocol.ts alone -- the Claw wire contract.
 *   runtime  (@primusclaw/personal-agent-runtime)  Node adapters of core's ports: depends on core only.
 *   teams    (@primusclaw/personal-agent-teams)    the Teams channel and the process: depends on core and runtime.
 *   test-support                                    fakes for tests; never imported by a package's src.
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
      comment: "A cycle couples modules that should have one direction between them.",
      from: {},
      to: { circular: true },
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
      comment: "runtime implements core's ports for Node; a channel depends on it, never the other way.",
      from: { path: "^packages/runtime/" },
      to: { path: "^packages/(teams|teams-ingress)/" },
    },
    {
      name: "teams-depends-on-core-and-runtime",
      severity: "error",
      comment: "teams uses core and runtime; it never reaches into another channel package.",
      from: { path: "^packages/teams/" },
      to: { path: "^packages/teams-ingress/" },
    },
    {
      name: "packages-through-their-entry",
      severity: "error",
      comment: "Another package is used through its public entry (src/index.ts), never by a deep path into its files.",
      from: { path: "^packages/([^/]+)/" },
      to: { path: "^packages/[^/]+/", pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"] },
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
