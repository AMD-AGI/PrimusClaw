// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent: the channel-neutral core of the personal agent.
 *
 * Layers (enforced by .dependency-cruiser.cjs and test/core-is-channel-neutral.test.ts): this package imports nothing
 * but itself, zod and the Claw wire contract (through ./protocol.ts). Everything else reaches it through a port
 * (`ports/`) or a plugin (`plugins/`), implemented by the runtime package, a channel package or a deployment.
 */
export * from "./errors.js";
export * from "./brief/index.js";
export * from "./feedback/index.js";
export * from "./json.js";
export * from "./own.js";
export * from "./guardrails/index.js";
export * from "./limits/index.js";
export * from "./review-text/index.js";
export { INTENT_PROMPT, MODE_PROMPT } from "./locales/review-github.js";
export * from "./typed-answer/index.js";
export * from "./understanding/index.js";
export * from "./locales/index.js";
export * from "./group-context/index.js";
export * from "./observe/index.js";
export * from "./plugins/index.js";
export * from "./ports/crypto.js";
export * from "./ports/index.js";
export * from "./ports/store/index.js";
export * from "./protocol.js";
export * from "./result.js";
export * from "./text/py-regex.js";
export * from "./text/py-text.js";
export * from "./validate.js";
export * from "./claw/credential.js";
export * from "./claw/errors.js";
export * from "./claw/model.js";
export * from "./claw/remote.js";
export * from "./config/settings.js";
export * from "./observability/security-events.js";
export * as turn from "./turn/index.js";
// (the assembly runs the changes card's read itself)
export { fetchChanges } from "./turn/changes.js";
export * from "./note/note.js";
export * from "./branding.js";
export * from "./claw/message-text.js";
export * from "./claw/requester-view.js";
export * from "./claw/service-refusal.js";
export * from "./claw/sse.js";
export * from "./claw/started-review.js";
export * from "./claw/work-item.js";
export * from "./locales/claw.js";
export * from "./public-error/index.js";
export * from "./security/redact.js";
export * from "./observability/ip-address.js";
export * from "./observability/security-fields.js";
export * from "./observability/security-log.js";
export * from "./claw/py-value.js";
export * from "./observability/metrics-catalog.js";
export * from "./language/detect.js";
export * from "./inbound-text/index.js";
export * from "./routing/index.js";
export * from "./approvals/index.js";
export * from "./assistant/index.js";
export * from "./assistant/work-items.js";
export type * from "./assistant/views.js";
export * from "./direct-chat/index.js";
export * from "./proactive/index.js";
export * from "./proactive/views.js";
export * from "./subscriptions/index.js";
export * from "./review/index.js";
export * as remoteDomain from "./remote/index.js";
export * as remoteView from "./remote-view/index.js";
// The remote agents, as the worker's assembly builds them (W6; the view it gives them is remoteView.createRemoteViews).
export { RemoteAgents } from "./remote/remote-agents.js";
export type { RemoteContext, RemoteErrors, RemoteGuard, RemoteSettings } from "./remote/context.js";
export { ConnectorSetup, setupFrom } from "./remote/connector/setup.js";
export { CredentialUnavailable as FollowCredentialUnavailable } from "./remote/follow/follower.js";
export type { FollowReach } from "./remote/follow/speaker.js";
export {
  DEFAULT_TIMINGS as REMOTE_FOLLOW_TIMINGS,
  WATCH_TIMINGS as REMOTE_WATCH_TIMINGS,
} from "./remote/follow/timings.js";
