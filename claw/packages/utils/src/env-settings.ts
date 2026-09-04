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
  /**
   * Refuse a value with a fractional part instead of truncating it.
   *
   * Off by default, because truncation is what every parser this replaced did
   * and a timeout of `1500.5` ms meaning 1500 ms harms nobody. Turn it on for
   * a setting whose values are an ENUMERATION rather than a quantity: there,
   * `3.5` is not an imprecise 3, it is a value the operator has to be told is
   * not one of the choices -- and truncating it hands back a neighbour that
   * happens to be legal, which is the silent-wrong-answer this module exists
   * to stop.
   */
  wholeNumbersOnly?: boolean;
  /**
   * Refuse a blank value instead of reading it as an absent setting.
   *
   * Off by default: `start-all.sh` does `set -a; source .env`, so every key
   * `.env.example` leaves empty arrives as `""`, and treating those as unset
   * is the only way the documented defaults ever apply. Turn it on where a
   * blank is more likely to be a value that failed to render -- a Helm
   * template that produced nothing -- than a line somebody left empty on
   * purpose, and where quietly running on the default is the wrong outcome.
   */
  blankIsRefused?: boolean;
}

/** A usable setting, or the reason it was refused. */
export type IntSetting = { value: number } | { problem: string };

/**
 * Parse an integer setting, refusing anything that would misbehave later.
 *
 * A fractional value is truncated rather than refused, which is what every
 * parser this replaces did. A value that is not entirely a number is refused,
 * which is where they differed and where the surprises came from. Both of
 * those defaults can be tightened per setting -- see `wholeNumbersOnly` and
 * `blankIsRefused` -- for settings where a near-miss is worse than a refusal.
 *
 * @param raw the raw environment value; blank or unset is not a problem by
 *        default, it is an absent setting, and the caller's default applies.
 */
export function readIntSetting(
  raw: string | undefined | null,
  {
    min = -PG_INT4_MAX,
    max = PG_INT4_MAX,
    wholeNumbersOnly = false,
    blankIsRefused = false,
  }: IntSettingBounds = {},
): IntSetting | null {
  const text = raw?.trim();
  if (!text) {
    // Unset is always absent -- there is nothing to refuse. Blank is a
    // judgement call the caller makes; see `blankIsRefused`.
    if (blankIsRefused && raw != null) return { problem: `is blank` };
    return null;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return { problem: `is not a number` };
  }
  if (wholeNumbersOnly && !Number.isInteger(parsed)) {
    return { problem: `is not a whole number` };
  }
  const value = Math.trunc(parsed);
  if (value < min || value > max) {
    return { problem: `is outside the usable range ${min}..${max}` };
  }
  return { value };
}
