// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An answer typed in a 1:1 chat to what waits for the person ("确认 #243", "#243 #234 都确认", "确认全自动"): the
 * rules that say what a message answers (typed_answer.py). Whether it is an answer at all is the model's reading
 * when there is one; what the rules cannot settle is asked back, never guessed.
 */
export * from "./mode.js";
export * from "./prompt.js";
export * from "./read.js";
