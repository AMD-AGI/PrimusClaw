// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY stand-in for W2's splitErrorTail (core root export); replaced by an import of it once W2's branch is merged in.

/** A failed turn's last text split into the model's own words and the error that ended it (the stand-in cuts nothing). */
export function splitErrorTail(text: string): { readonly kept: string; readonly tail: string } {
  return { kept: text, tail: "" };
}
