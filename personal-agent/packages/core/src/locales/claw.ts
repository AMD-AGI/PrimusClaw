// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * What a person is told of Claw's refusal of a call only an identity-provider token may make (answering a held merge,
 * a session that acts as a user): the reason only; the caller says what was not done. The Python worker says these in
 * English to everyone, so the Chinese entries are the same text until they are translated on purpose.
 */
const serviceRefusals = {
  service_client_not_allowed:
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client.",
  interactive_sign_in_required: "PrimusClaw did not take my credential for you as a sign-in; tell the operator.",
  only_the_acting_user_can_decide: "PrimusClaw says this answer is not yours to give.",
} as const;

export const clawText = defineCatalog({ en: serviceRefusals, zh: serviceRefusals });
