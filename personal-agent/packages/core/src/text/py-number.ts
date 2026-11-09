// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Numbers as Python writes them: `repr(float)`, `str`/`json.dumps` of a parsed JSON number, `f"{x:.{n}f}"`. */

/**
 * A number as Python writes it, for a value parsed from JSON: a safe integer as the int JSON gave, anything else as
 * Python's float `repr` (`1e-07`, `1e+300`). `str` writes the non-finite as `nan`/`inf`, `json.dumps` as `NaN`/
 * `Infinity`. What JSON cannot tell apart once JavaScript has parsed it is written the common way: a float `1.0` was
 * already the number 1, `-0.0` is `0`, an integer beyond 2^53 is written as the float it became.
 */
export function pyNumber(value: number, how: "str" | "json"): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return how === "str" ? "nan" : "NaN";
    if (how === "str") return value > 0 ? "inf" : "-inf";
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (Number.isSafeInteger(value)) return String(value);
  return floatRepr(value);
}

/** Python's `repr(float)`: the shortest digits, positional for exponents -4..15, else `d.ddde±XX`. */
export function floatRepr(value: number): string {
  const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = mantissa.startsWith("-") ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const exp = `${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
    return `${sign}${digits.charAt(0)}${fraction}e${exp}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1) || "0";
  return `${sign}${whole}.${fraction}`;
}

/** A finite, non-negative double exactly: `mantissa * 2^exponent`. */
function exactParts(value: number): { readonly mantissa: bigint; readonly exponent: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = (bits >> 52n) & 0x7ffn;
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0n) return { mantissa: fraction, exponent: -1074n }; // subnormal
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075n };
}

/**
 * `f"{value:.{digits}f}"`: the exact binary value rounded to `digits` decimals, an exact tie to even, as Python formats
 * it (for any magnitude and any number of digits).
 */
export function fixedN(value: number, digits: number): string {
  if (!Number.isFinite(value)) return pyNumber(value, "str");
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const { mantissa, exponent } = exactParts(Math.abs(value));
  let numerator = mantissa * 10n ** BigInt(digits);
  let denominator = 1n;
  if (exponent >= 0n) numerator <<= exponent;
  else denominator <<= -exponent;
  let quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const text = quotient.toString().padStart(digits + 1, "0");
  return digits === 0 ? sign + text : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** `f"{value:.1f}"`. */
export function fixed1(value: number): string {
  return fixedN(value, 1);
}
