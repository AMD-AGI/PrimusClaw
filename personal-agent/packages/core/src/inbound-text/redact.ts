// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The masking the inbound texts apply in a group conversation (credential-shaped values: the Python worker's
 * `redact.redact_text(...)[0]`), passed in by the caller. The texts here do not own a masking rule of their own.
 */

/** Masks credential-shaped values in `text`. */
export type Redact = (text: string) => string;

/** No masking: the default where a caller passes none (a 1:1 conversation needs none). */
export const noRedact: Redact = (text) => text;
