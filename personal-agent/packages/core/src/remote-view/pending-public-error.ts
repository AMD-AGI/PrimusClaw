// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY stand-in for W2's public_error port (personal-agent core); replaced by W2's module once its branch is merged in.
/** A failed turn's last text split into the model's own words and the error that ended it (the stand-in cuts nothing). */
export function splitErrorTail(text: string): [string, string] {
  return [text, ""];
}
