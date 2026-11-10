// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every view's Teams renderer. A feature line adds its `Partial<Renderers>` module here (`teams/src/views/<feature>/index.ts`);
 * `RENDERERS` must name every view core declares, so a view without a renderer does not compile.
 */
import { approvalRenderers } from "./approval/index.js";
import { assistantRenderers } from "./assistant/index.js";
import { COMMAND_RENDERERS } from "./commands/index.js";
import { FEEDBACK_RENDERERS } from "./feedback/index.js";
import { OBSERVE_RENDERERS } from "./observe/index.js";
import { proactiveRenderers } from "./proactive/index.js";
import type { Renderers } from "./registry.js";
import { REMOTE_RENDERERS } from "./remote/index.js";
import { REVIEW_RENDERERS } from "./review/index.js";
import { TURN_RENDERERS } from "./turn/index.js";

export const RENDERERS: Renderers = {
  ...REMOTE_RENDERERS,
  ...approvalRenderers,
  ...assistantRenderers,
  ...COMMAND_RENDERERS,
  ...proactiveRenderers,
  ...TURN_RENDERERS,
  ...REVIEW_RENDERERS,
  ...FEEDBACK_RENDERERS,
  ...OBSERVE_RENDERERS,
};

export { renderView, type Renderer, type Renderers, type TeamsMessage } from "./registry.js";
