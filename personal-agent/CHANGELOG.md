<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Changelog

The three packages (`@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`,
`@primusclaw/personal-agent-teams`) and the `personal-agent-teams` image are released together at one version. Each
release is the tag `personal-agent-vX.Y.Z`, and its section here is the GitHub Release's notes (README.md,
"Releasing"): a version without a section is not released. While the version is 0.x, a patch release fixes and a minor
release adds; a change to a plugin port (core's `src/plugins/`) is always a minor release and is called out here.

## 0.1.0

The first release.

- `@primusclaw/personal-agent`: the channel-neutral core, with the Claw wire contract compiled in, and every port and
  plugin interface (`Plugins`, `neutralPlugins`, `IntegrationRegistry`).
- `@primusclaw/personal-agent-runtime`: the Node adapters of core's ports (SQLite store, Fernet, the Claw client, the
  token exchange, metrics, settings and secrets, the HTTP server).
- `@primusclaw/personal-agent-teams`: the Microsoft Teams channel and the process assembly (`buildWorker`, `main`,
  `WorkerOptions.registerIntegrations`), with the worker program as `dist/main.js`.
- The `personal-agent-teams` image: the three packages installed from their checked tarballs on Node.js 26, running as
  uid 65534, with `personal_agent_build_info` on `/metrics`.
