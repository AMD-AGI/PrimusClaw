// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `personal_agent_build_info`: which build a running worker is, on /metrics (the `*_build_info` convention: a gauge that
 * is always 1, the build in its labels). `version` is the surface package's own version (what npm and the image were
 * released as; "unknown" when its package.json cannot be read), `node` the Node.js version it runs on. A deployment
 * checks that what runs is what it pinned by reading this line.
 */
export const BUILD_INFO_METRIC = "personal_agent_build_info";

/** A label value as the Prometheus text format writes it. */
function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** The metric's lines (HELP, TYPE and the sample), each ending in a newline. */
export function buildInfoText(version: string, node: string): string {
  return [
    `# HELP ${BUILD_INFO_METRIC} The running build of the personal agent: always 1, the build in its labels.`,
    `# TYPE ${BUILD_INFO_METRIC} gauge`,
    `${BUILD_INFO_METRIC}{version="${label(version)}",node="${label(node)}"} 1`,
    "",
  ].join("\n");
}

/** `render`'s text with the build info appended (after a newline, if the text lacks its last one). */
export function withBuildInfo(render: () => string, info: string): () => string {
  return () => {
    const text = render();
    return (text === "" || text.endsWith("\n") ? text : text + "\n") + info;
  };
}
