// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";

/**
 * A turn the model gateway refused for a reason the person can fix (the Python worker's `apim_key`: no key bound for
 * the model, or one the gateway no longer accepts). The turn engine asks the policy whether the answer is such a
 * refusal; if it is, the turn runs once more on the fallback model (when one is configured), the answer is led by
 * `fallbackLead`, and when there is no fallback or it fails too the person is told `guidance` instead of a raw error.
 */
export interface ModelRefusal {
  /** Which refusal, in the policy's own words ("missing", "invalid", ...). */
  readonly kind: string;
}

export interface ModelRefusalPolicy {
  /**
   * Whether the turn's whole answer is such a refusal. `failed` is how Claw ended the turn: undefined while not known
   * (the live view: the whole message has to be the error), true (it is the error text, beginning with it is enough),
   * false (Claw says it succeeded, so it is an answer).
   */
  classify(answer: string, failed: boolean | undefined): ModelRefusal | undefined;
  /** What the person is told instead of the refused answer (markdown, in `lang`). */
  guidance(refusal: ModelRefusal, lang: Lang): string;
  /** The line in front of an answer the fallback model gave (markdown, in `lang`). */
  fallbackLead(refusal: ModelRefusal, lang: Lang): string;
}

/** No gateway refusal is recognised: every answer is an answer. */
export const noModelRefusalPolicy: ModelRefusalPolicy = {
  classify: () => undefined,
  guidance: () => "",
  fallbackLead: () => "",
};
