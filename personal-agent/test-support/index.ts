// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Shared test fakes. Ownership: W0 = clock, random, surface (recording outbound), inbound (event builders), http-server; W3 = card catalog and
 * recording Bot Connector; W5 = assistant fake/world; W6 = remote fake/world; W7 = review requests. Production code never
 * imports from here (the dependency rules refuse it).
 */
export * from "./clock.js";
export * from "./http-server.js";
export * from "./inbound.js";
export * from "./random.js";
export * from "./surface.js";
