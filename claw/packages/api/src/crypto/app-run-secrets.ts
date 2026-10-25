// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sealing of the credentials an app run owns: its MCP token and, when a grant
 * hook issues one, the grant's keys.
 *
 * Same primitive and key as the rest of the API's secrets (`@claw/utils`
 * AES-256-GCM under the boot-validated `USER_ENV_ENCRYPTION_KEY`). Each blob is
 * bound to its run and field through AAD, so a value copied from one run's row
 * to another's, or from `mcp_token_enc` into `grant_keys_enc`, fails to open
 * instead of being trusted.
 *
 * Plaintext never leaves this module except through `openAppRunSecret`, which
 * the app runner calls to build the sandbox environment.
 */
import { randomBytes } from "node:crypto";
import { openAead, sealAead } from "@claw/utils";
import { userEnvMasterKey } from "./user-env.js";

export type AppRunSecretField = "mcp_token" | "grant_keys";

/** Prefix that lets secret scanners recognise the token (design 5.4). */
export const MCP_TOKEN_PREFIX = "cmt_";

/** 32 random bytes, base64url, with the scanner-friendly prefix. */
export function newMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function aad(taskId: string, field: AppRunSecretField): Buffer {
  return Buffer.from(`claw.app-run/v1|${taskId}|${field}`, "utf8");
}

export function sealAppRunSecret(
  plaintext: string,
  taskId: string,
  field: AppRunSecretField,
): string {
  return sealAead(userEnvMasterKey(), Buffer.from(plaintext, "utf8"), aad(taskId, field));
}

export function openAppRunSecret(
  sealed: string,
  taskId: string,
  field: AppRunSecretField,
): string {
  return openAead(userEnvMasterKey(), sealed, aad(taskId, field)).toString("utf8");
}
