// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The View -> Teams message framework. Core says WHAT a person sees as a semantic view (`View`: a name and a model, no card
 * JSON); each feature says HOW Teams shows its views in `teams/src/views/<feature>/`, as a partial `Renderers` object, and
 * `views/index.ts` joins them into the one complete `Renderers`. A view name without a renderer does not compile.
 */
import type { ViewMap } from "@primusclaw/personal-agent";

import type { JsonObject } from "../cards/json.js";

/** What a renderer turns a view into: one Teams message activity (a card message, or a text/xml message). */
export type TeamsMessage = JsonObject & { type: string };

export type Renderer<M> = (model: M) => TeamsMessage;

/** One renderer per view name core declares. */
export type Renderers = { readonly [K in keyof ViewMap]: Renderer<ViewMap[K]> };

/** The message Teams shows for `view` (core's `View`: any of them). */
export function renderView<K extends keyof ViewMap>(
  renderers: Renderers,
  view: { readonly name: K; readonly model: ViewMap[K] },
): TeamsMessage {
  const renderer: Renderer<ViewMap[K]> = renderers[view.name];
  return renderer(view.model);
}
