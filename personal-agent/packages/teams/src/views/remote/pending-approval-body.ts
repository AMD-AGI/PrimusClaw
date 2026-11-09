// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY: the approval card's body (Python `approval_view.card_body`) is W5's; until its Teams renderer lands, a permission
// card shows the header and the action alone. The `remote_permission` snapshot stays pending until then.
import type { CardElement } from "../../cards/json.js";
import { facts, header } from "../../cards/kit.js";

export function pendingApprovalBody(action: string, _input: unknown, lang: "en" | "zh"): CardElement[] {
  const zh = lang === "zh";
  return [
    header(zh ? "需要你批准" : "Approval needed", { tone: "warning", emoji: "needs_you" }),
    ...facts([[zh ? "操作" : "Action", action]]),
  ];
}
