// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGeakPrompt, buildHyperloomPrompt } from "../src/workbenches/prompt-builders.js";

test("buildHyperloomPrompt rejects an empty image", () => {
  assert.throws(
    () => buildHyperloomPrompt({ modelName: "TestModel", modelPath: "/models/test", image: "" }),
    /HYPERLOOM_DEFAULT_IMAGE is not configured/,
  );
});

test("buildGeakPrompt rejects an empty image", () => {
  assert.throws(
    () => buildGeakPrompt({ files: "kernel.py", image: "  " }),
    /GEAK_DEFAULT_IMAGE is not configured/,
  );
});

test("prompt builders trim explicit images before rendering", () => {
  const image = "registry.example.com/test/image:tag";
  const hyperloomPrompt = buildHyperloomPrompt({
    modelName: "TestModel",
    modelPath: "/models/test",
    image: ` ${image} `,
  });
  const geakPrompt = buildGeakPrompt({
    files: "kernel.py",
    image: ` ${image} `,
    apiBase: "http://litellm.example.svc:4000/v1",
  });

  assert.ok(hyperloomPrompt.includes(`SandboxImage: ${image}`));
  assert.doesNotMatch(hyperloomPrompt, /SandboxImage:  /);
  assert.ok(geakPrompt.includes(`image: "${image}"`));
});

test("buildGeakPrompt requires and renders an explicit LiteLLM API base", () => {
  assert.throws(
    () => buildGeakPrompt({ files: "kernel.py", image: "registry.example.com/geak:test" }),
    /LITELLM_API_BASE is not configured/,
  );
  assert.throws(
    () => buildGeakPrompt({
      files: "kernel.py",
      image: "registry.example.com/geak:test",
      apiBase: null as unknown as string,
    }),
    /LITELLM_API_BASE is not configured/,
  );

  const prompt = buildGeakPrompt({
    files: "kernel.py",
    image: "registry.example.com/geak:test",
    apiBase: "http://litellm.example.svc:4000/v1",
  });
  assert.match(prompt, /api_base: "http:\/\/litellm\.example\.svc:4000\/v1"/);
});
