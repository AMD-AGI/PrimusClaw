// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every view's Teams renderer. A feature line adds its `Partial<Renderers>` module here (`teams/src/views/<feature>/index.ts`);
 * `RENDERERS` must name every view core declares, so a view without a renderer does not compile.
 */
import { approvalRenderers } from "./approval/index.js";
import { assistantRenderers } from "./assistant/index.js";
import { FEEDBACK_RENDERERS } from "./feedback/index.js";
import { proactiveRenderers } from "./proactive/index.js";
import type { Renderers } from "./registry.js";
import { TURN_RENDERERS } from "./turn/index.js";

export const RENDERERS: Renderers = {
  ...approvalRenderers,
  ...assistantRenderers,
  ...FEEDBACK_RENDERERS,
  ...proactiveRenderers,
  ...TURN_RENDERERS,
};

export { renderView, type Renderer, type Renderers, type TeamsMessage } from "./registry.js";
