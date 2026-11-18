// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ConfigError, decimalBigInt, pyStrip } from "@primusclaw/personal-agent";

import { settingSource, settingValue } from "./aliases.js";

/** The process environment, or a test's. */
export type Env = Readonly<Record<string, string | undefined>>;

const ON = ["1", "true", "yes", "on"];
const OFF = ["0", "false", "no", "off"];

/**
 * Reads settings out of an environment, with the worker's rules: a typo stops the worker, it never picks a value. A
 * setting that has a `PA_` name and an older `TEAMS_` name is read under either (`settingSource`), and a message about
 * its value names the variable it was read from.
 */
export class EnvReader {
  constructor(readonly env: Env) {}

  /** The variable `name` is read from (the `PA_` or the `TEAMS_` name of a pair; any other name as it is). */
  source(name: string): string {
    return settingSource(this.env, name);
  }

  /** The raw value ("" unset). */
  raw(name: string, fallback = ""): string {
    return settingValue(this.env, name) ?? fallback;
  }

  /** The value without surrounding white space ("" unset). */
  text(name: string, fallback = ""): string {
    return pyStrip(this.raw(name, fallback));
  }

  /** A value that must be set and not blank. */
  required(name: string): string {
    const value = this.text(name);
    if (value === "") throw new ConfigError(`environment variable ${this.source(name)} is required`);
    return value;
  }

  /** On or off; `fallback` when unset or empty; anything else stops the worker. */
  switch(name: string, fallback: boolean): boolean {
    const value = this.text(name).toLowerCase();
    if (value === "") return fallback;
    if (!ON.includes(value) && !OFF.includes(value)) {
      throw new ConfigError(`${this.source(name)} must be on or off, not ${pyRepr(value)}`);
    }
    return ON.includes(value);
  }

  /** On only for the words that mean on (the older switches, which read anything else as off). */
  isOn(name: string): boolean {
    return ON.includes(this.text(name).toLowerCase());
  }

  /** A positive whole number; `fallback` when unset or empty; anything else stops the worker. */
  positiveInt(name: string, fallback: number): number {
    const value = this.text(name);
    if (value === "") return fallback;
    // Python's `raw.isdigit() and int(raw) > 0`: decimal digits of any script
    const number = decimalBigInt(value);
    if (number === undefined || number <= 0n) {
      throw new ConfigError(`${this.source(name)} must be a positive whole number, not ${pyRepr(value)}`);
    }
    return Number(number);
  }

  /** A whole number (Python's `int()` of the value: a sign, surrounding space and `_` between digits allowed). */
  int(name: string, fallback: string): number {
    const value = pyStrip(this.raw(name, fallback));
    const match = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(value);
    const digits = match === null ? undefined : decimalBigInt((match[2] ?? "").replaceAll("_", ""));
    if (match === null || digits === undefined) {
      throw new ConfigError(`${this.source(name)} must be a whole number, not ${pyRepr(value)}`);
    }
    return Number(match[1] === "-" ? -digits : digits);
  }

  /** A whole number, or null when unset or blank. */
  optionalInt(name: string): number | null {
    return this.text(name) === "" ? null : this.int(name, "");
  }

  /** A comma separated list, blank entries dropped; `lower` lower-cases each entry. */
  list(name: string, lower = false): string[] {
    return this.raw(name)
      .split(",")
      .map((entry) => pyStrip(entry))
      .filter((entry) => entry !== "")
      .map((entry) => (lower ? entry.toLowerCase() : entry));
  }
}

/** Python's `repr()` of a string, for an error message that quotes a value the way the Python worker did. */
export function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return quote + (quote === "'" ? escaped.replace(/'/g, "\\'") : escaped) + quote;
}

/** `value` without a trailing slash (Python's `rstrip("/")`). */
export function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end -= 1;
  return value.slice(0, end);
}
