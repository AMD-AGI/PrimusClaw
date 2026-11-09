// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { clawText } from "../locales/claw.js";
import type { Lang } from "../locales/lang.js";
import type { ClawError } from "./errors.js";

/** The sentence for a refusal of Claw's: its reason (a word it does not name reads as the last one) and what was not done. */
export function serviceRefusal(err: ClawError, undone: string, lang: Lang = "en"): string {
  const reasons = clawText.in(lang);
  const code = err.code;
  const reason =
    code === "service_client_not_allowed" || code === "interactive_sign_in_required"
      ? reasons[code]
      : reasons.only_the_acting_user_can_decide;
  return `${reason} ${undone}`;
}
