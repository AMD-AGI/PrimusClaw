// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How domain code tells Claw's refusals apart without depending on the HTTP client's error class (W2's ClawPort): Claw answered
 * with an HTTP status (and, for some refusals, an `error` code) as against no answer at all.
 */
export interface ClawRefusal {
  readonly status: number;
  readonly code?: string | undefined;
}

/** Whether `error` is Claw's answer with a status (the Python worker's `ClawError`), as against a transport failure. */
export function clawRefusal(error: unknown): ClawRefusal | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  if (typeof status !== "number" || status <= 0) return undefined;
  const code = "code" in error ? (error as { code: unknown }).code : undefined;
  return { status, code: typeof code === "string" ? code : undefined };
}

/** Whether `error` is Claw refusing with `status`. */
export function refusedWith(error: unknown, ...statuses: number[]): boolean {
  const refusal = clawRefusal(error);
  return refusal !== undefined && statuses.includes(refusal.status);
}
