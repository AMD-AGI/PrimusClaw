// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The value of one top-level string field of a JSON object that is still being written: what a tool call's arguments look
 * like while the model streams them (`input_json_delta`). `{"text": "Hel` gives `Hel`; `{"item_id": "#3", "text": "a\nb` gives
 * `a` + newline + `b`.
 *
 * Only a field of the outermost object is read, so `"text"` inside another value (a nested object, or a string that happens to
 * contain the word) is never taken for it. An escape cut off at the end of what has arrived is left out until the rest of it
 * arrives, so every result is a prefix of the field's final value. Null while the field has not started, when it is not a
 * string, or when the text so far is not the start of a JSON object.
 */
export function partialStringField(json: string, field: string): string | null {
  let i = skipSpace(json, 0);
  if (json[i] !== "{") return null;
  i++;
  for (;;) {
    i = skipSpace(json, i);
    if (i >= json.length || json[i] === "}") return null;
    if (json[i] === ",") { i++; continue; }
    if (json[i] !== "\"") return null;
    const key = readString(json, i + 1);
    if (!key.closed) return null;
    i = skipSpace(json, key.end);
    if (i >= json.length) return null;
    if (json[i] !== ":") return null;
    i = skipSpace(json, i + 1);
    if (i >= json.length) return null;
    if (key.value === field) {
      if (json[i] !== "\"") return null;
      return readString(json, i + 1).value;
    }
    const end = skipValue(json, i);
    if (end === null) return null;
    i = end;
  }
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\n" || s[i] === "\r" || s[i] === "\t")) i++;
  return i;
}

const ESCAPES: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** A JSON string's characters from `i` (just after its opening quote): decoded as far as they have arrived. */
function readString(s: string, i: number): { value: string; closed: boolean; end: number } {
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\"") return { value: out, closed: true, end: i + 1 };
    if (c !== "\\") {
      // The first half of a character whose second half has not arrived waits for it, as an escape does.
      if (i + 1 >= s.length && c >= "\ud800" && c <= "\udbff") break;
      out += c;
      i++;
      continue;
    }
    if (i + 1 >= s.length) break;
    const e = s[i + 1];
    if (e === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      const code = Number.parseInt(hex, 16);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, closed: false, end: s.length };
      // A high surrogate whose low half has not arrived yet waits for it, so a character is never shown half-made.
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = s.slice(i + 6, i + 12);
        if (low.length < 6) break;
        if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(low)) {
          out += String.fromCharCode(code, Number.parseInt(low.slice(2), 16));
          i += 12;
          continue;
        }
      }
      out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    if (!(e in ESCAPES)) return { value: out, closed: false, end: s.length };
    out += ESCAPES[e];
    i += 2;
  }
  return { value: out, closed: false, end: s.length };
}

/** The index just after a complete JSON value starting at `i`, or null when it has not all arrived. */
function skipValue(s: string, i: number): number | null {
  if (s[i] === "\"") {
    const str = readString(s, i + 1);
    return str.closed ? str.end : null;
  }
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\"") {
      const str = readString(s, i + 1);
      if (!str.closed) return null;
      i = str.end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && c === ",") return i;
    i++;
  }
  return null;
}
