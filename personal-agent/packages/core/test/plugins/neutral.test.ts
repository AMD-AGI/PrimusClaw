// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { integrationRegistry, neutralPlugins, noIntegrations } from "../../src/index.js";

test("the neutral plugins name no integrations, and a deployment's registry takes their place", () => {
  assert.equal(neutralPlugins().integrations, noIntegrations);
  const registry = integrationRegistry();
  registry.addMcpServer("tracker", "Tracker");
  assert.equal(neutralPlugins({ integrations: registry }).integrations.mcpServers.get("tracker"), "Tracker");
});
