// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export { SCAN_MAX, looksInternal, looksLikeFailure, looksLikeServiceError, splitErrorTail } from "./classify.js";
export type { ErrorTail } from "./classify.js";
export { DETAIL_LOG_MAX, PublicErrorLog, newRef } from "./public-error-log.js";
export type { PublicErrors, WithheldIds } from "./public-errors.js";
