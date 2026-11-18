// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run that failed while its turn did not.
 *
 * A turn whose sandbox the platform could not provide still ends with an answer:
 * the model is told the sandbox is unavailable and says so. The conversation's
 * account of that turn is a normal ending (`exec_complete` with `failed: false`),
 * and it stays one, so whatever reads a turn's answer (a chat, an assistant
 * router) is unchanged. The run is another matter: none of the work that needed
 * the sandbox ran, and a caller reading the run (`GET /v1/runs`) has to see that,
 * and why. These two `exec_complete` fields carry it; the API records the run as
 * failed with them.
 */

/** The `exec_complete` field with the code the run failed for (e.g. `sandbox_unschedulable`). */
export const RUN_FAILURE_REASON_FIELD = "run_failure_reason";
/** The `exec_complete` field with what happened, for a person. */
export const RUN_FAILURE_MESSAGE_FIELD = "run_failure_message";
