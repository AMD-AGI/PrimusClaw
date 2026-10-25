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

/** A file for {@link writeSandboxFiles}. */
export interface SandboxFile {
  path: string;
  content: string;
  /** Octal permission bits. */
  mode: "600" | "644";
}

/**
 * Write `files` into `dir` in ONE shell command (one exec round trip): the
 * directory is created and set to 0700, and each file is created under a
 * restrictive umask and renamed into place, so it is never visible half-written
 * or with wider permissions than its `mode`. Content travels base64-encoded like
 * {@link writeSandboxSshKey}; the command string is not logged by callers.
 * Every file must live directly in `dir`.
 */
export async function writeSandboxFiles(
  exec: SandboxExec,
  dir: string,
  files: readonly SandboxFile[],
): Promise<void> {
  const steps = files.map((f) => {
    if (f.path.slice(0, f.path.lastIndexOf("/")) !== dir) throw new Error(`${f.path} is not directly in ${dir}`);
    const encoded = Buffer.from(f.content, "utf-8").toString("base64");
    return `printf '%s' '${encoded}' | base64 -d > '${f.path}.tmp' && chmod ${f.mode} '${f.path}.tmp' && mv '${f.path}.tmp' '${f.path}'`;
  });
  const command = [`umask 077`, `mkdir -p '${dir}'`, `chmod 700 '${dir}'`, ...steps].join(" && ");
  const res = await exec(command, "30s");
  if (res.exitCode !== 0) {
    throw new Error(`failed to write files in ${dir} (exit ${res.exitCode}): ${res.stderr.slice(0, 200)}`);
  }
}
