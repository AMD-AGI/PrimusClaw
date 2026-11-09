// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Numbers and histograms in the Prometheus text format (version 0.0.4), written as the Python worker wrote them. */

/** Python's `round(value, 3)`: a tie on the exact binary value goes to the even neighbour. */
export function round3(value: number): number {
  const scaled = value * 1000;
  const floor = Math.floor(scaled);
  if (Number.isFinite(scaled) && scaled - floor === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 1000;
  return Number(value.toFixed(3));
}

/** Python's `repr(float(value))`: the shortest digits, in exponent form below 1e-4 and from 1e16 on. */
export function pyFloatRepr(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  const [mantissa = "0", exp = "0"] = value.toExponential().split("e");
  const exponent = Number(exp);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const shown = digits.length > 1 ? `${digits[0] ?? ""}.${digits.slice(1)}` : digits;
    return `${sign}${shown}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction === "" ? "0" : fraction}`;
}

/** A sample's value: a whole number as an integer, anything else as Python's float repr. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
}

/** Bucket counts of one histogram series: cumulative buckets, the sum and the count. */
export class Histogram {
  private readonly counts: number[];
  private total = 0;
  private count = 0;

  constructor(private readonly buckets: readonly number[]) {
    this.counts = buckets.map(() => 0);
  }

  observe(value: number): void {
    const v = Math.max(value, 0);
    this.buckets.forEach((bound, i) => {
      if (v <= bound) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
    this.total += v;
    this.count += 1;
  }

  lines(name: string, labels: string): string[] {
    const out = this.buckets.map(
      (bound, i) => `${name}_bucket{${labels},le="${formatNumber(bound)}"} ${String(this.counts[i] ?? 0)}`,
    );
    out.push(`${name}_bucket{${labels},le="+Inf"} ${String(this.count)}`);
    out.push(`${name}_sum{${labels}} ${formatNumber(round3(this.total))}`);
    out.push(`${name}_count{${labels}} ${String(this.count)}`);
    return out;
  }
}
