// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which interpreter the `bash` tool runs commands under.
 *
 * It was `/bin/sh` everywhere. On an image whose `/bin/sh` is dash, a command
 * written in bash -- which is what a tool named `bash` is given -- failed on its
 * first `[[` before it had done anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
const { bash } = await import("../src/tools/shell/bash.js");
const { resolveCommandShell } = await import("../src/tools/shell/process-runner.js");
const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidate(dir: string, name: string, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, mode);
  return path;
}

test("the first executable candidate is the shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "command-shell-"));
  const present = candidate(dir, "bash", 0o755);
  assert.equal(resolveCommandShell([join(dir, "missing"), present]), present);
});

test("a candidate that is present but not executable is passed over", () => {
  const dir = mkdtempSync(join(tmpdir(), "command-shell-"));
  const unusable = candidate(dir, "bash", 0o644);
  assert.equal(resolveCommandShell([unusable]), "/bin/sh");
});

test("an image without bash still gets a shell", () => {
  assert.equal(resolveCommandShell([join(tmpdir(), "no-such-bash")]), "/bin/sh");
});

test(
  "bash-only syntax runs where the image has bash",
  { skip: !executable("/bin/bash") && "no /bin/bash on this host" },
  async () => {
    const result = await bash.execute({
      command: 'value=ok; name=value; [[ "${!name}" == ok ]] && echo "indirect ${!name}"',
    });
    const { content, isError } = result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(isError, undefined, content[0].text);
    assert.equal(content[0].text.trim(), "indirect ok");
  },
);
