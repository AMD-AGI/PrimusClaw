// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a *(owner scope, run identity, shell id)* triple becomes one filesystem
 * path, and how a reader proves a record is where its own fields say it is.
 *
 * The three parts arrive as arbitrary strings. Used verbatim as path segments
 * they would let one triple name another's record: `/` spans a segment
 * boundary, `..` climbs out of the subtree, and a NUL truncates. The encoding
 * below removes every one of those as a consequence of its shape rather than by
 * a check laid over it -- `.` never survives it, so no segment is or contains
 * `.` or `..`; `/` and NUL never survive it, so no part can reach another
 * part's level.
 *
 * There is deliberately no digest fallback for an over-long part. A hash is not
 * injective, so two distinct triples could reproduce one path and the reader's
 * re-encode check would have nothing to catch it with. The part is carried
 * whole down directory levels instead.
 */

/** Marker byte for an escape. Escaped itself, so decoding is unambiguous. */
const ESCAPE = "~";

/** Longest component the encoder emits before chunking a part. */
const CHUNK_BYTES = 200;

/**
 * Largest a scope part may be, in UTF-8 bytes.
 *
 * The arrival check caps at 200 UTF-16 code units, which admits up to 600 raw
 * bytes; the path is built from bytes, so the cap that binds is this one.
 */
export const MAX_SCOPE_PART_BYTES = 200;

/** The shell id's own accepted set, enforced at the tool boundary. */
export const SHELL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The run-identity segment for a start that presented none.
 *
 * Outside `E`'s image for every possible input -- `E` writes `.` only as `~2E`,
 * so no output of it contains a `.` at any position -- which is what keeps the
 * reserved location unreachable by a real run identity, and a hand-written
 * record naming the literal text rejectable by the ordinary re-encode check.
 */
export const NO_RUN_SEGMENT = ".norun";

/** A run identity that is absent rather than empty. */
export const ABSENT_RUN = Symbol("absent-run");
export type RunPart = string | typeof ABSENT_RUN;

const UNRESERVED = /[A-Za-z0-9_-]/;

/** Encode one part over its UTF-8 bytes. Injective by construction. */
export function encodePart(part: string): string {
  let out = "";
  for (const byte of Buffer.from(part, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch)
      ? ch
      : ESCAPE + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function decodePart(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== ESCAPE) {
      bytes.push(encoded.charCodeAt(i));
      continue;
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`record path: malformed escape at ${i}`);
    bytes.push(parseInt(hex, 16));
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Split one encoded part into path components.
 *
 * Chunked whole rather than compressed: concatenating the bodies in path order
 * reproduces the encoding byte for byte, and the terminal `.e` component fixes
 * where the part ends, so two different parts cannot produce one path.
 */
function chunk(encoded: string): string[] {
  const out: string[] = [];
  let rest = encoded;
  while (rest.length > CHUNK_BYTES) {
    out.push(`.c${rest.slice(0, CHUNK_BYTES)}`);
    rest = rest.slice(CHUNK_BYTES);
  }
  out.push(`.e${rest}`);
  return out.length === 1 ? [encoded] : out;
}

/** Reject a scope part the path cannot be built from, by name and by rule. */
export function assertScopePart(field: string, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0) {
    throw new Error(`record path: ${field} must not be empty`);
  }
  if (bytes > MAX_SCOPE_PART_BYTES) {
    throw new Error(
      `record path: ${field} is ${bytes} UTF-8 bytes, over the ${MAX_SCOPE_PART_BYTES}-byte limit`,
    );
  }
}

export function assertShellId(value: string): void {
  if (!SHELL_ID_PATTERN.test(value)) {
    throw new Error(
      "shell_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and be neither '.' nor '..'",
    );
  }
}

/** The path components below `scopes/` for one triple, outermost first. */
export function recordComponents(
  ownerScope: string,
  runIdentity: RunPart,
  shellId: string,
): string[] {
  assertScopePart("owner scope", ownerScope);
  assertShellId(shellId);
  const run = runIdentity === ABSENT_RUN
    ? [NO_RUN_SEGMENT]
    : (assertScopePart("run identity", runIdentity), chunk(encodePart(runIdentity)));
  return [...chunk(encodePart(ownerScope)), ...run, ...chunk(encodePart(shellId))];
}

/**
 * Whether a record's own three fields reproduce the path it was read from.
 *
 * One rule with two cases, applied without exemption: owner and shell segments
 * are always the encoding of the field, the run segment is the reserved literal
 * where the run field is the absent marker and the encoding otherwise. A record
 * hand-written into someone else's location fails here.
 */
export function componentsMatch(
  components: string[],
  ownerScope: string,
  runIdentity: RunPart,
  shellId: string,
): boolean {
  try {
    const expected = recordComponents(ownerScope, runIdentity, shellId);
    return expected.length === components.length
      && expected.every((part, i) => part === components[i]);
  } catch {
    return false;
  }
}
