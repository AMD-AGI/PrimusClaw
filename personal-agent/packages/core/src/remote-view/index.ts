// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a person sees of a remote agent (a coding agent on their own machine, reached through Claw's remote-agents API): reading
 * its events, the live view of a turn, the lines a chat attached to it is told, and the views of its cards. Nothing here talks
 * to Claw or a channel.
 */
export * from "./actions.js";
export * from "./agents-view.js";
export * from "./agents.js";
export * from "./answer.js";
export * from "./conversations-view.js";
export * from "./conversations.js";
export * from "./events.js";
export * from "./health.js";
export { defang, lit, neutral, plain } from "./inert.js";
export * from "./limits.js";
export * from "./lines.js";
export * from "./listing.js";
export * from "./live-view.js";
export * from "./machine-views.js";
export * from "./options.js";
export type { RemoteAgent, RemoteConnector, RemoteSession } from "./pending-model.js";
export * from "./permission-view.js";
export * from "./sessions-view.js";
export * from "./status-view.js";
export type { Reported } from "./reported.js";
export * from "./setup.js";
export * from "./turn-state.js";
