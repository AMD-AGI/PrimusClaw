// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one place the personal agent reaches the Claw wire contract. The definitions live in `claw/packages/protocol`
 * and are compiled in, never copied: Claw, the connector and the personal agent share the field names, the event
 * types and the limits by construction, and a field Claw renames or drops fails this workspace's typecheck.
 * `test/protocol-source.test.ts` fails if any other file under `packages/` imports that path or restates a constant.
 *
 * Other modules import from `./protocol.js` (inside core) or from `@primusclaw/personal-agent` (runtime, teams).
 */
export * from "../../../../claw/packages/protocol/src/claw-api/index.js";
export * from "../../../../claw/packages/protocol/src/remote-agents.js";
