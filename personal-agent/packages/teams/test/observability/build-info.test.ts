// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `personal_agent_build_info`: its text, the version it names, and how it joins the rest of /metrics. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import { buildInfoText, teamsVersion, withBuildInfo } from "../../src/observability/build-info.js";

it("the build info is one gauge of 1 with the version and the Node.js version as labels", () => {
  assert.equal(
    buildInfoText("0.1.0", "v26.0.0"),
    [
      "# HELP personal_agent_build_info The running build of the personal agent: always 1, the build in its labels.",
      "# TYPE personal_agent_build_info gauge",
      'personal_agent_build_info{version="0.1.0",node="v26.0.0"} 1',
      "",
    ].join("\n"),
  );
  // (a label value is escaped as the text format requires, so no value can break the line)
  assert.match(buildInfoText('a"b\\c\nd', "v"), /\{version="a\\"b\\\\c\\nd",node="v"\} 1\n$/);
});

it("the version is the teams package's own", () => {
  const own = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.match(own.version, /^\d+\.\d+\.\d+$/);
  assert.equal(teamsVersion(), own.version);
});

it("the build info follows the rest of /metrics on a line of its own", () => {
  assert.equal(withBuildInfo(() => "a 1\n", "b 1\n")(), "a 1\nb 1\n");
  assert.equal(withBuildInfo(() => "a 1", "b 1\n")(), "a 1\nb 1\n");
  assert.equal(withBuildInfo(() => "", "b 1\n")(), "b 1\n");
  let renders = 0;
  const render = withBuildInfo(() => `a ${String(++renders)}\n`, "b 1\n");
  assert.equal(render(), "a 1\nb 1\n");
  assert.equal(render(), "a 2\nb 1\n"); // (the metrics are read anew on every scrape)
});
