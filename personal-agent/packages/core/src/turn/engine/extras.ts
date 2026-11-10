// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What may follow an answer. Each is best effort: an extra that cannot be shown never fails the turn. */

import { fetchChanges } from "../changes.js";
import { type Delivery, DELIVERIES_MAX, deliveryLine } from "../deliveries.js";
import { errorName } from "../../errors.js";
import { viewMessage } from "../views.js";
import { credential, type TurnContext } from "./context.js";

/** Under a message that says something went wrong: one button that starts /feedback. */
export async function offerReport(ctx: TurnContext): Promise<void> {
  const report = ctx.hooks.reportMessage;
  if (!report) return;
  try {
    await ctx.deps.surface.send(report());
  } catch (err) {
    ctx.deps.log.warn("the Report a problem card could not be sent", { error: errorName(err) });
  }
}

/** Under the final answer of a turn from a client whose thumbs never reach us: the worker's own thumbs. */
export async function offerThumbs(ctx: TurnContext): Promise<void> {
  try {
    await ctx.deps.surface.send(ctx.deps.cards.thumbs());
  } catch (err) {
    ctx.deps.log.warn("the thumbs card could not be sent", { error: errorName(err) });
  }
}

/**
 * Under a finished answer: what the session changed, with Create PR and Open diff in Claw. Nothing is shown for anything
 * that is not a plain success: no changes, a sandbox that is gone, a slow or failed call.
 */
export async function offerChanges(ctx: TurnContext, sessionId: string): Promise<void> {
  try {
    const changes = await fetchChanges(ctx.deps.claw, await credential(ctx), sessionId, ctx.deps.log);
    if (!changes) return;
    const model = { changes, sessionId, publicBaseUrl: ctx.request.publicBaseUrl };
    await ctx.deps.surface.send(viewMessage("changes", model, "Changes"));
  } catch (err) {
    ctx.deps.log.warn("the changes card could not be shown", { error: errorName(err) });
  }
}

/**
 * After the answer: the files the agent delivered. A 1:1 chat gets a card for each (a small image shown in it), a group
 * chat one line each with the link and nothing of the file.
 */
export async function offerDeliveries(
  ctx: TurnContext,
  sessionId: string,
  deliveries: readonly Delivery[],
): Promise<void> {
  for (const delivery of deliveries.slice(0, DELIVERIES_MAX)) {
    const url = ctx.deps.claw.deliveryLink(sessionId, delivery.id);
    if (!url) continue;
    try {
      if (ctx.request.group) {
        await ctx.deps.surface.send({ body: { type: "rich", markdown: deliveryLine(delivery, url), lead: false } });
      } else {
        await ctx.deps.surface.send(viewMessage("delivery", { delivery, url }, delivery.name));
      }
    } catch (err) {
      ctx.deps.log.warn("a delivered file of the session could not be shown", {
        session: sessionId,
        error: errorName(err),
      });
    }
  }
}
