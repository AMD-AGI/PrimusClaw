// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a number out of the environment, in one place.
 *
 * There were three of these, and they disagreed about what a bad value is.
 * `parseInt` reads a prefix, so `TASK_SWEEPER_TICK_MS=6e4` -- a perfectly
 * ordinary way to write sixty thousand -- became a 6 ms sweeper loop, and
 * `60s` became 60 ms. None of them had a ceiling, so a grace period of
 * 3000000000 seconds passed every sanity check the callers made and then
 * overflowed `$1::int` on every sweeper tick, taking the reapers behind it
 * down with it on every pass.
 *
 * Both failures share a shape: the value is wrong in a way the operator cannot
 * see, and the damage shows up somewhere with no connection to the setting. So
 * this refuses instead of guessing, and hands back a sentence explaining what
 * it refused for whoever is validating configuration at startup.
 */

/**
 * The widest value Postgres accepts for an `int` parameter.
 *
 * The default ceiling because most of these settings end up as `$n::int` in a
 * sweeper query, where exceeding it is not a clamped value but a thrown query.
 */
export const PG_INT4_MAX = 2_147_483_647;

/** What a setting is allowed to be. Both ends inclusive. */
export interface IntSettingBounds {
  /** Defaults to the negative of {@link PG_INT4_MAX}: many settings use a non-positive value to mean "off". */
  min?: number;
  /** Defaults to {@link PG_INT4_MAX}. */
  max?: number;
}

/** A usable setting, or the reason it was refused. */
export type IntSetting = { value: number } | { problem: string };

/**
 * Parse an integer setting, refusing anything that would misbehave later.
 *
 * A fractional value is truncated rather than refused, which is what every
 * parser this replaces did. A value that is not entirely a number is refused,
 * which is where they differed and where the surprises came from.
 *
 * @param raw the raw environment value; blank or unset is not a problem, it is
 *        an absent setting, and the caller's default applies.
 */
export function readIntSetting(
  raw: string | undefined | null,
  { min = -PG_INT4_MAX, max = PG_INT4_MAX }: IntSettingBounds = {},
): IntSetting | null {
  const text = raw?.trim();
  if (!text) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return { problem: `is not a number` };
  }
  const value = Math.trunc(parsed);
  if (value < min || value > max) {
    return { problem: `is outside the usable range ${min}..${max}` };
  }
  return { value };
}
