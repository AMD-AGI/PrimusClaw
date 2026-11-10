// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { turn } from "@primusclaw/personal-agent";

import { buttons, execute, icon, message, note } from "../../cards/kit.js";

/**
 * The Stop button of a turn that started from a phone, where Teams' own Stop under a streaming reply is greyed out. A
 * small card of its own, one destructive button; the token names the turn it was sent for, so a press after that turn has
 * ended stops nothing. Single column, Action.Execute only (what Teams mobile sends back).
 */
export function stopCard(model: turn.StopModel): ReturnType<typeof message> {
  const t = turn.stopText.in(model.lang);
  return message(
    [note(icon("stopped", t.card))],
    buttons([execute(t.button, "primusclaw.turn_stop", { primusclaw: "turn_stop", turn: model.token })], "destructive"),
  );
}
