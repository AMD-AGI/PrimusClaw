// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The `?token=<api-key>` auth path exists only because a browser navigating via
 * `<a href>` / `window.open` cannot set an Authorization header. Keys in URLs
 * leak into access logs, proxy logs, browser history and Referer headers, so the
 * fallback must stay confined to those download routes. This pins the allowlist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { authLogPath, isBrowserDownloadPath } from "../src/auth/middleware.js";

test("authLogPath strips query credentials before logging", () => {
  const secret = "ak-super-secret-query-key";
  const path = authLogPath(`/v1/sessions/abc/files/main.py?token=${secret}&download=1`);
  assert.equal(path, "/v1/sessions/abc/files/main.py");
  assert.equal(path.includes(secret), false);
});

test("isBrowserDownloadPath: accepts session file downloads", () => {
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/files/main.py"), true);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/files/src/deep/main.py"), true);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/files/src/main.py/stream"), true);
});

test("isBrowserDownloadPath: accepts the async zip download", () => {
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/zip-tasks/t1/download"), true);
});

test("isBrowserDownloadPath: rejects the zip poll endpoint (no browser navigation)", () => {
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/zip-tasks/t1"), false);
});

test("isBrowserDownloadPath: rejects the file listing and other session routes", () => {
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/files"), false);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc"), false);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/messages"), false);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/upload"), false);
});

test("isBrowserDownloadPath: rejects unrelated and admin surfaces", () => {
  assert.equal(isBrowserDownloadPath("/v1/sessions"), false);
  assert.equal(isBrowserDownloadPath("/v1/admin/users"), false);
  assert.equal(isBrowserDownloadPath("/v1/internal/tasks/t1/event"), false);
  assert.equal(isBrowserDownloadPath("/a2a/v1"), false);
  assert.equal(isBrowserDownloadPath("/anthropic/v1/messages"), false);
});

test("isBrowserDownloadPath: cannot be widened by a crafted path", () => {
  // A leading segment must be exactly /v1/sessions/<id>/...
  assert.equal(isBrowserDownloadPath("/v1/sessions/a/b/files/x"), false);
  assert.equal(isBrowserDownloadPath("/evil/v1/sessions/abc/files/x"), false);
  assert.equal(isBrowserDownloadPath("/v1/sessions/abc/zip-tasks/t1/download/../../admin"), false);
});
