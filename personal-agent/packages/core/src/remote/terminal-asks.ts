// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What is kept of a question a terminal asks (a connector's approval hooks), for the clicks on its card. */
import type { RemotePermission } from "../ports/store/remote.js";
import { PERSISTED_SHOWN_WHOLE } from "../legacy-names.js";
import type { PermissionOption } from "./options.js";

/** The field of a kept terminal ask that says its card showed the request whole (set by this worker, never by Claw). */
export const SHOWN_WHOLE = PERSISTED_SHOWN_WHOLE;

/** Whether `perm` is a question a terminal asks. */
export function isTerminalPermission(perm: RemotePermission): boolean {
  return perm.ask?.["origin"] === "terminal";
}

/** Whether `option` may be chosen for `perm`: a terminal's question not shown whole may only be turned down from here. */
export function mayChoose(perm: RemotePermission, option: PermissionOption): boolean {
  return !isTerminalPermission(perm) || option.kind.startsWith("reject") || perm.ask?.[SHOWN_WHOLE] === true;
}
