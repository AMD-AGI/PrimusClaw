// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The conversations hidden on one machine, each with Unhide; then Unhide all and Back to the list. */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import type { Connector } from "../remote/model.js";
import { type RemoteButton, remoteButton } from "../remote/actions.js";
import { hiddenOf } from "../remote/conversations.js";
import { lit } from "../remote/inert.js";
import { agoEpoch } from "../remote/time.js";

/** Hidden conversations one card lists (a connector reports at most twelve per agent). */
export const HIDDEN_SHOWN = 20;

export interface HiddenView {
  readonly lang: Lang;
  readonly title: string;
  readonly entries: readonly { readonly title: string; readonly where: string; readonly unhide: RemoteButton }[];
  /** Said when nothing is hidden; null otherwise. */
  readonly nothing: string | null;
  readonly actions: readonly RemoteButton[];
}

/** The hidden conversations of `connector` (from a listing with them included). */
export function hiddenView(connector: Connector, now: number, lang: Lang = "en"): HiddenView {
  const words = remoteText.in(lang);
  const cid = connector.connectorId;
  const entries = connector.agents.flatMap(hiddenOf);
  const actions =
    entries.length > 0 ? [remoteButton(words.unhideAll, "unhide", null, { connector_id: cid, all: "1" })] : [];
  actions.push(remoteButton(words.backToList, "list"));
  return {
    lang,
    title: words.hiddenTitle({ machine: lit(connector.name, 80) }),
    entries: entries.slice(0, HIDDEN_SHOWN).map((entry) => {
      const when = agoEpoch(now, entry.updatedAt, lang);
      return {
        title: lit(entry.title, 80) || words.untitled,
        where: lit(entry.cwd, 80) + (when ? ` · ${when}` : ""),
        unhide: remoteButton(words.unhide, "unhide", null, { connector_id: cid, ref: entry.ref }),
      };
    }),
    nothing: entries.length > 0 ? null : words.nothingHidden,
    actions,
  };
}
