// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertMultiNodeInferaModel,
  isMultiNodeRequest,
  parseMultiNodePromptFlags,
  requestedNodeCount,
} from "../src/sandbox/multi-node/prompt-flags.js";
import { classifySandboxFailure } from "../src/sandbox/reaper.js";

/** Synthetic prompt preserving the parser's nested flags and continuations. */
const REAL_PROMPT = `Use the skill at /shared/skills/inference_optimizer/SKILL.md to optimize inference performance.

FLAGS  (keep as --flags):
--gpu-type mi325x \\
--model /models/Qwen3-30B-A3B \\
--target-gain 30 \\
--precision bf16 \\
--max-hours 4 \\
--mn-backend rayjob \\
--framework=sglang \\
--nodes 2 \\
--gpus-per-node 8 \\
--cpus-per-node 90 \\
--mem-per-node 1024 \\
--tp 8 --ep 8 \\
--isl 1024 \\
--osl 1024 \\
--conc 128 \\
--no-framework-agent \\
--server-args "--attention-backend aiter --mem-fraction-static 0.8 --max-running-requests 1024" \\
--extra-env MC_GID_INDEX=3 \\
--extra-env NCCL_IB_GID_INDEX=3 \\
--extra-env SGLANG_USE_AITER_AR=0

Environment (keep as env):
RANDOM_RANGE_RATIO=0.8
`;

/**
 * Verbatim excerpt of a real PD-disaggregated Infera prompt. The `--pd-*-extra-args`
 * blocks are kept because they are the parser's main trap: they contain dozens of
 * inner `--flags` that must not be mistaken for the real ones.
 */
const INFERA_PROMPT = `Use the skill at /shared/skills/inference_optimizer/SKILL.md to optimize inference performance.

FLAGS  (keep as --flags):
--gpu-type mi325x \\
--model /models/Qwen3-30B-A3B \\
--target-gain 30 \\
--precision bf16 \\
--max-hours 4 \\
--mn-backend infera \\
--framework=sglang \\
--nodes 2 \\
--gpus-per-node 8 \\
--cpus-per-node 90 \\
--mem-per-node 1024 \\
--isl 1024 \\
--osl 1024 \\
--conc 128 \\
--tp 8 --ep 8 \\
--mn-image registry.example.com/primus-claw/sglang:test \\
--pd-mode disaggregated \\
--pd-prefill-nodes 1 --pd-decode-nodes 1 \\
--pd-prefill-tp 8 --pd-decode-tp 8 \\
--pd-prefill-ep 8 --pd-decode-ep 8 \\
--pd-transfer-backend mooncake \\
--pd-prefill-extra-args \\"--attention-backend aiter --mem-fraction-static 0.78 --disable-radix-cache --ep-dispatch-algorithm fake --load-balance-method round_robin --watchdog-timeout 3600 --deepep-mode normal --enable-dp-attention --moe-dense-tp-size 1 --enable-dp-lm-head --chunked-prefill-size 8192 --trust-remote-code\\" \\
--pd-decode-extra-args \\"--attention-backend aiter --mem-fraction-static 0.82 --enable-dp-attention --deepep-mode normal --ep-dispatch-algorithm fake --load-balance-method round_robin --watchdog-timeout 3600 --moe-dense-tp-size 1 --enable-dp-lm-head --chunked-prefill-size 8192 --max-running-requests 1024 --trust-remote-code\\"

Pod-side env (platform injection; forwarded to pods):
PATH_TO_BNXT_TAR_PACKAGE=/shared/drivers/libbnxt_re-test.tar.gz
MC_GID_INDEX=3
`;

test("parseMultiNodePromptFlags reads the real optimize prompt", () => {
  const spec = parseMultiNodePromptFlags(REAL_PROMPT);
  assert.deepStrictEqual(spec, {
    nodes: 2,
    gpusPerNode: 8,
    cpusPerNode: 90,
    memPerNodeGiB: 1024,
    backend: "rayjob",
    image: "",
    // --extra-env is repeatable (argparse action="append").
    extraEnv: {
      MC_GID_INDEX: "3",
      NCCL_IB_GID_INDEX: "3",
      SGLANG_USE_AITER_AR: "0",
    },
    model: "/models/Qwen3-30B-A3B",
    framework: "sglang",
    kvTransferBackend: "mori",
    pdMode: "aggregated",
    pdPrefillNodes: 0,
    pdDecodeNodes: 0,
    pdPrefillTp: 0,
    pdDecodeTp: 0,
  });
});

test("parseMultiNodePromptFlags drops malformed and reserved --extra-env entries", () => {
  const spec = parseMultiNodePromptFlags(
    "--nodes 2 --mn-backend rayjob" +
      " --extra-env GOOD=1" +
      " --extra-env noequals" +      // no '=' -> skipped
      " --extra-env =novalue" +      // empty key -> skipped
      " --extra-env EMPTY=" +        // empty value is allowed
      " --extra-env RAY_JOB_ENTRYPOINT=evil", // reserved by the template
  );
  assert.deepStrictEqual(spec?.extraEnv, { GOOD: "1", EMPTY: "" });
});

test("parseMultiNodePromptFlags applies Hyperloom's own defaults for omitted flags", () => {
  // Only the two required flags given: gpus/cpus/mem fall back to parser.py
  // defaults (8/96/1024).
  const spec = parseMultiNodePromptFlags("optimize --nodes 4 --mn-backend rayjob");
  assert.deepStrictEqual(spec, {
    nodes: 4,
    gpusPerNode: 8,
    cpusPerNode: 96,
    memPerNodeGiB: 1024,
    backend: "rayjob",
    image: "",
    extraEnv: {},
    model: "",
    framework: "sglang",
    kvTransferBackend: "mori",
    pdMode: "aggregated",
    pdPrefillNodes: 0,
    pdDecodeNodes: 0,
    pdPrefillTp: 0,
    pdDecodeTp: 0,
  });
});

test("parseMultiNodePromptFlags returns null when --nodes is below 2", () => {
  assert.equal(parseMultiNodePromptFlags(""), null, "empty prompt");
  assert.equal(parseMultiNodePromptFlags("just run something"), null, "no flags -> nodes defaults to 1");
  assert.equal(parseMultiNodePromptFlags("--nodes 1 --mn-backend rayjob"), null, "explicit single node");
});

test("parseMultiNodePromptFlags requires an explicit, known --mn-backend", () => {
  // Without it a bare --nodes would provision a cluster on whichever engine
  // happened to be the default, so the task stays single-node instead.
  assert.equal(parseMultiNodePromptFlags("--nodes 4"), null, "backend omitted");
  assert.equal(parseMultiNodePromptFlags("--nodes 4 --mn-backend torchrun"), null, "unknown backend");
  assert.equal(parseMultiNodePromptFlags("--nodes 4 --mn-backend"), null, "flag with no value");
  assert.equal(parseMultiNodePromptFlags("--nodes 4 --mn-backend RayJob")?.backend, "rayjob", "case-insensitive");
  assert.equal(parseMultiNodePromptFlags("--nodes 4 --mn-backend=infera")?.backend, "infera", "--flag=value form");
});

test("requestedNodeCount reports --nodes even when the backend check rejects the task", () => {
  assert.equal(requestedNodeCount("--nodes 4"), 4);
  assert.equal(requestedNodeCount("no flags"), 1);
});

test("parseMultiNodePromptFlags reads the infera backend and its PD topology", () => {
  const spec = parseMultiNodePromptFlags(INFERA_PROMPT)!;
  assert.equal(spec.backend, "infera");
  assert.equal(spec.nodes, 2);
  assert.equal(spec.gpusPerNode, 8);
  assert.equal(spec.cpusPerNode, 90);
  assert.equal(spec.model, "/models/Qwen3-30B-A3B");
  assert.equal(spec.framework, "sglang");
  assert.equal(spec.kvTransferBackend, "mooncake");
  assert.equal(spec.pdMode, "disaggregated");
  assert.deepStrictEqual(
    [spec.pdPrefillNodes, spec.pdDecodeNodes, spec.pdPrefillTp, spec.pdDecodeTp],
    [1, 1, 8, 8],
  );
  assert.equal(
    spec.image,
    "registry.example.com/primus-claw/sglang:test",
  );
});

test("parseMultiNodePromptFlags is not confused by --pd-*-nodes when reading --nodes", () => {
  // `--pd-prefill-nodes` must not satisfy the `--nodes` pattern, or a PD prompt
  // would size the cluster from the prefill group instead of the total.
  const spec = parseMultiNodePromptFlags(
    "--mn-backend rayjob --pd-prefill-nodes 1 --pd-decode-nodes 1 --nodes 4",
  )!;
  assert.equal(spec.nodes, 4);
});

test("parseMultiNodePromptFlags rejects out-of-enum framework and transfer backend", () => {
  const spec = parseMultiNodePromptFlags(
    "--nodes 2 --mn-backend rayjob --framework=torch --pd-transfer-backend rdma",
  )!;
  assert.equal(spec.framework, "sglang", "unknown framework falls back to the default");
  assert.equal(spec.kvTransferBackend, "mori", "unknown KV backend falls back to the default");
});

test("parseMultiNodePromptFlags accepts both `--flag value` and `--flag=value`", () => {
  const spaced = parseMultiNodePromptFlags("--nodes 3 --gpus-per-node 4 --mn-backend rayjob");
  const equals = parseMultiNodePromptFlags("--nodes=3 --gpus-per-node=4 --mn-backend=rayjob");
  assert.deepStrictEqual(equals, spaced);
  assert.equal(spaced?.nodes, 3);
  assert.equal(spaced?.gpusPerNode, 4);
});

/** The same flags as a markdown bullet list, which is how a task JSON writes them. */
const BULLET_PROMPT = `Required optimize CLI flags (forward every one verbatim):
- \`--gpu-type mi355x\`
- \`--model /models/GLM-5.3\`
- \`--mn-backend infera\`
- \`--nodes 2\`
- \`--gpus-per-node 8\`
- \`--cpus-per-node 64\`
- \`--mn-image registry.example.com/primus-claw/infera:glm53\`
- \`--pd-mode disaggregated\`
- \`--pd-prefill-nodes 1\`
- \`--pd-decode-nodes 1\`
- \`--pd-transfer-backend mooncake\`
- \`--extra-env MC_GID_INDEX=3\`
- \`--extra-env SGLANG_USE_AITER=1\`
`;

test("parseMultiNodePromptFlags reads flags wrapped in markdown backticks", () => {
  const spec = parseMultiNodePromptFlags(BULLET_PROMPT)!;
  assert.ok(spec, "a bulleted prompt is still a multi-node request");
  assert.equal(spec.nodes, 2);
  assert.equal(spec.backend, "infera");
  assert.equal(spec.model, "/models/GLM-5.3");
  assert.equal(spec.image, "registry.example.com/primus-claw/infera:glm53");
  assert.equal(spec.cpusPerNode, 64);
  assert.equal(spec.pdMode, "disaggregated");
  assert.equal(spec.kvTransferBackend, "mooncake");
  assert.deepStrictEqual(spec.extraEnv, { MC_GID_INDEX: "3", SGLANG_USE_AITER: "1" });
  assert.equal(isMultiNodeRequest({ prompt: BULLET_PROMPT }), true);
});

test("parseMultiNodePromptFlags keeps separators inside a value", () => {
  // Only the outermost decoration goes, so a comma-separated list survives it.
  const spec = parseMultiNodePromptFlags(
    "--nodes 2 --mn-backend infera --extra-env `NCCL_IB_HCA=rdma0,rdma1`",
  )!;
  assert.deepStrictEqual(spec.extraEnv, { NCCL_IB_HCA: "rdma0,rdma1" });
});

test("parseMultiNodePromptFlags treats a value that is only decoration as absent", () => {
  const spec = parseMultiNodePromptFlags("--nodes 2 --mn-backend infera --cpus-per-node `")!;
  assert.equal(spec.cpusPerNode, 96, "falls back to the parser.py default");
});

test("isMultiNodeRequest follows the prompt flags, not the request body", () => {
  assert.equal(isMultiNodeRequest({ prompt: REAL_PROMPT }), true);
  // Single node, or no --mn-backend: the task stays sandbox-only.
  assert.equal(isMultiNodeRequest({ prompt: "--nodes 1 --mn-backend rayjob" }), false);
  assert.equal(isMultiNodeRequest({ prompt: "--nodes 2" }), false);
  assert.equal(isMultiNodeRequest({}), false);
});

test("assertMultiNodeInferaModel rejects infera without --model", () => {
  const spec = parseMultiNodePromptFlags("--nodes 2 --mn-backend infera");
  assert.ok(spec);
  assert.throws(
    () => assertMultiNodeInferaModel(spec),
    /multi-node infera request requires --model/,
  );
});

test("assertMultiNodeInferaModel allows infera with --model", () => {
  const spec = parseMultiNodePromptFlags(
    "--nodes 2 --mn-backend infera --model /models/Qwen3-30B-A3B",
  );
  assert.ok(spec);
  assert.doesNotThrow(() => assertMultiNodeInferaModel(spec));
});

test("classifySandboxFailure maps infera model errors", () => {
  assert.equal(
    classifySandboxFailure(
      "multi-node infera request requires --model (infera frontend --router-tokenizer-path)",
    ),
    "infera_model_missing",
  );
  assert.equal(
    classifySandboxFailure("model is required (infera frontend --router-tokenizer-path)"),
    "infera_model_missing",
  );
});

test("classifySandboxFailure maps multi-node cluster provisioning errors", () => {
  assert.equal(
    classifySandboxFailure("multi-node workload create failed: HTTP 500 {\"error\":\"quota\"}"),
    "mn_cluster_create_failed",
  );
  assert.equal(
    classifySandboxFailure("multi-node workload msg-1 entered terminal phase=failed"),
    "mn_cluster_terminal",
  );
  assert.equal(
    classifySandboxFailure("multi-node workload msg-1 not ready within the provisioning timeout"),
    "mn_cluster_timeout",
  );
  assert.equal(
    classifySandboxFailure("multi-node requires CLAW_DEPLOY_MODE=safe (got kubernetes)"),
    "rayjob_config_invalid",
  );
});
