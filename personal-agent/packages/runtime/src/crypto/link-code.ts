// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a `/link` code is stored: HMAC-SHA256 under a key derived from one Fernet key, never the code or a plain digest
 * of it (40 bits of a plain SHA-256 are searched offline in minutes). Byte for byte the Python worker's derivation.
 */
import { createHmac } from "node:crypto";

import { urlsafeB64Decode } from "./py-base64.js";

/** The label the key is derived under. A new label is a new key: every pending code is void. */
export const LINK_HASH_LABEL = "primusclaw-teams/link-code-hmac/v1";

/** The HMAC key link codes are hashed under, derived from one Fernet key of TEAMS_ENCRYPTION_KEYS. */
export function linkHashKey(fernetKey: string): Uint8Array {
  return Uint8Array.from(createHmac("sha256", urlsafeB64Decode(fernetKey)).update(LINK_HASH_LABEL).digest());
}

/** A link code as it is stored (hex). */
export function hashLinkCode(code: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(code, "utf8").digest("hex");
}
