// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A neutral ModelRefusalPolicy for the turn engine's tests: a model gateway that refuses a person without a model key
 * with "403 NO-MODEL-KEY ..." (or "401 MODEL-KEY-MISSING ..."), and one whose key it no longer takes with
 * "401 MODEL-KEY-INVALID ...". The real rules (and their words) are a deployment's plugin; these only give the engine
 * the same three answers: none, missing, invalid.
 */

import type { Lang } from "../../src/locales/lang.js";
import type { ModelRefusal, ModelRefusalPolicy } from "../../src/plugins/model-refusal-policy.js";
import { PUBLIC } from "./world.js";

export const LINK = `${PUBLIC}/model-keys`;
/** The gateway's refusal for a person with no key, as the whole message. */
export const RAW403 = "403 NO-MODEL-KEY: no model key is bound for this user";
export const RAW401 = "401 MODEL-KEY-MISSING: the request carried no model key";
/** The same with the router's suffix after it, as a live turn carried it (one line). */
export const LIVE401 = `${RAW401} (router: no fallback model group for model m; available fallbacks: none)`;
export const LIVE_INVALID401 = "401 MODEL-KEY-INVALID: the model key is not valid (router: no fallback model group)";

const MISSING = /^\s*(?:403 NO-MODEL-KEY|401 MODEL-KEY-MISSING)\b/;
const INVALID = /^\s*401 MODEL-KEY-INVALID\b/;

function kindOf(text: string, failed: boolean | undefined): string | undefined {
  // the whole message (one line) is the refusal; when Claw says the turn failed, beginning with it is enough
  const whole = !text.trim().includes("\n");
  if (!whole && failed !== true) return undefined;
  if (MISSING.test(text)) return "missing";
  if (INVALID.test(text)) return "invalid";
  return undefined;
}

export const fakeRefusals: ModelRefusalPolicy = {
  classify(answer: string, failed: boolean | undefined): ModelRefusal | undefined {
    if (failed === false) return undefined; // Claw says it succeeded: an answer, whatever it says
    const kind = kindOf(answer, failed);
    return kind ? { kind } : undefined;
  },
  guidance(refusal: ModelRefusal, lang: Lang): string {
    if (refusal.kind === "invalid") {
      return lang === "zh"
        ? `你上传的模型 Key 无效或已过期。请重新上传一个有效的：\n${LINK}\n\n上传之后再问我一次。`
        : `The model key you uploaded is invalid or expired.\n\nPlease upload a valid one here:\n${LINK}\n\nThen ask me again.`;
    }
    return lang === "zh"
      ? `你还没有上传模型 Key，所以我暂时无法为你调用模型。\n\n请先在这里上传：\n${LINK}\n\n上传之后再问我一次。`
      : `You have not uploaded your model key yet, so I cannot call a model for you.\n\nPlease upload it here:\n${LINK}\n\nThen ask me again.`;
  },
  fallbackLead(refusal: ModelRefusal, lang: Lang): string {
    if (refusal.kind === "invalid") {
      return lang === "zh"
        ? `你的模型 Key 无效或已过期，这次用的是备用模型；重新上传有效的 Key 即可恢复： ${LINK}`
        : `Your model key is invalid or expired, so a backup model answered. Upload a valid one to get yours back: ${LINK}`;
    }
    return lang === "zh"
      ? `你还没有上传模型 Key，这次用的是备用模型；上传后即可恢复： ${LINK}`
      : `You have no model key, so a backup model answered. Upload one to get yours back: ${LINK}`;
  },
};
