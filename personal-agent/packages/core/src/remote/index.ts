// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The remote agents' domain as other packages see it (`remoteDomain` of the core entry): what a connector reports and how it is
 * read, the session's events, the limits, the reasons, the lines said in a chat, and the inputs of the cards (`RemoteViews`).
 * The view (core/src/remote-view, `remoteView`) builds on these and never passes them on.
 */
export * from "./actions.js";
export * from "./agents.js";
export * from "./answer.js";
export * from "./conversations.js";
export * from "./events.js";
export * from "./health.js";
export { defang, lit, neutral, plain } from "./inert.js";
export * from "./limits.js";
export { breakAddresses, inertAnswer } from "./links/answer.js";
export * from "./lines.js";
export * from "./listing.js";
export * from "./options.js";
export type { Reported } from "./reported.js";
export * from "./setup.js";
export * from "./turn-state.js";
export type { AgentsInput, SessionsInput, StatusInput, WindowApproval, WindowInput } from "./ports.js";
