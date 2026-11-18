// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The markers a mention is replaced with in a message's text (`⟦i⟧` is mentions[i]), so that a name in a mention is
 * never read as written words. The channel's inbound text (marked text) writes them; the readings here skip them.
 */
export const MARK_OPEN = "⟦";
export const MARK_CLOSE = "⟧";
