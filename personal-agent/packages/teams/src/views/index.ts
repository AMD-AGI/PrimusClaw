// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every view's Teams renderer. A feature line adds its `Partial<Renderers>` module here (`teams/src/views/<feature>/index.ts`);
 * `RENDERERS` must name every view core declares, so a view without a renderer does not compile.
 */
import { FEEDBACK_RENDERERS } from "./feedback/index.js";
import type { Renderers } from "./registry.js";

export const RENDERERS: Renderers = { ...FEEDBACK_RENDERERS };

export { renderView, type Renderer, type Renderers, type TeamsMessage } from "./registry.js";
