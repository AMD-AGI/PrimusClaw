// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every view's Teams renderer. A feature line adds its `Partial<Renderers>` module here (`teams/src/views/<feature>/index.ts`);
 * `RENDERERS` must name every view core declares, so a view without a renderer does not compile.
 */
import type { Renderers } from "./registry.js";
import { remoteRenderers } from "./remote/index.js";
import { pendingApprovalBody } from "./remote/pending-approval-body.js";

export const RENDERERS: Renderers = {
  ...remoteRenderers(pendingApprovalBody),
};

export { renderView, type Renderer, type Renderers, type TeamsMessage } from "./registry.js";
