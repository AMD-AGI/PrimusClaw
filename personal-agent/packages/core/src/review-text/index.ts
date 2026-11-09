// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a review request's text: the people it names, the pull requests it points at, the numbers written on their
 * own, and the words of an ask (github_review.py; shared by the review delegation and the assistant's understanding).
 */
export * from "./asks.js";
export * from "./bare-numbers.js";
export {
  MAX_CANDIDATES,
  displayName,
  markerIndexes,
  markerKeys,
  markerPattern,
  memberKeys,
  memberMatches,
  memberNames,
  mentionId,
  namedIn,
  namedWithin,
  normName,
  oneLine,
  personOf,
  plainText,
  samePerson,
  sortedCp,
  tokens,
  withoutMarkers,
  withoutParens,
  writtenIn,
} from "./names.js";
export type { Mention, Place } from "./names.js";
export * from "./pull-ref.js";
export {
  NAME_PADDING,
  bareName,
  casefold,
  codePoints,
  flat,
  isAlnum,
  isWordChar,
  stripChars,
  unique,
} from "./text/unicode.js";
