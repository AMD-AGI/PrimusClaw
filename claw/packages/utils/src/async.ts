// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
