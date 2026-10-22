// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Materialise the Infera control-plane private key inside the sandbox.
 *
 * Hyperloom's external mode reads the key from a path
 * (`HYPERLOOM_MN_EXT_SSH_KEY`), and a workload's env is fixed at create time, so
 * the key is written over the sandbox exec channel once the sandbox is healthy.
 */

export type SandboxExec = (
  command: string,
  timeout: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Write `privateKeyPem` to `path` with 0600 perms. The PEM is transported
 * base64-encoded so its newlines and slashes survive the shell verbatim.
 */
export async function writeSandboxSshKey(
  exec: SandboxExec,
  path: string,
  privateKeyPem: string,
): Promise<void> {
  const encoded = Buffer.from(privateKeyPem, "utf-8").toString("base64");
  const command =
    `umask 077 && printf '%s' '${encoded}' | base64 -d > '${path}' && chmod 600 '${path}'`;
  const res = await exec(command, "30s");
  if (res.exitCode !== 0) {
    throw new Error(`failed to write multi-node SSH key (exit ${res.exitCode}): ${res.stderr.slice(0, 200)}`);
  }
}

/**
 * Write `content` to `path` with the given permission bits, creating parent
 * directories (0700) as needed. Same transport as {@link writeSandboxSshKey}.
 * The file is created under a restrictive umask and renamed into place, so it is
 * never visible half-written or with wider permissions than `mode`.
 */
export async function writeSandboxFile(
  exec: SandboxExec,
  path: string,
  content: string,
  mode: "600" | "644",
): Promise<void> {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const command =
    `umask 077 && mkdir -p '${dir}' && printf '%s' '${encoded}' | base64 -d > '${path}.tmp' ` +
    `&& chmod ${mode} '${path}.tmp' && mv '${path}.tmp' '${path}'`;
  const res = await exec(command, "30s");
  if (res.exitCode !== 0) {
    throw new Error(`failed to write ${path} (exit ${res.exitCode}): ${res.stderr.slice(0, 200)}`);
  }
}
