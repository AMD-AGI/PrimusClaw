// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { InboundFile } from "@primusclaw/personal-agent";
import { onlyConnector } from "../../src/connector/hosts.js";
import { inboundFiles } from "../../src/inbound/attachments.js";
import { shownFileName, TeamsFileFetcher } from "../../src/inbound/fetcher.js";
import { FakeClock } from "../../../../test-support/clock.js";
import {
  BOT_URL,
  bytes,
  dm,
  fetcher,
  fileInfo,
  image,
  pasted,
  PNG,
  RecordingLogger,
  sent,
  SHAREPOINT,
  Tokens,
} from "./fakes.js";

const X = bytes("x");

test("a pasted image is fetched with the bots token and a file link without one", async () => {
  const { files, seen } = fetcher((url) =>
    url.pathname.includes("attachments")
      ? { body: PNG, headers: { "content-type": "image/png" } }
      : { body: bytes("%PDF-1.7"), headers: { "content-type": "application/pdf" } },
  );
  const { fetched, failed } = await files.fetchAll([pasted(), sent("report.pdf", SHAREPOINT)]);
  assert.deepEqual(failed, []);
  assert.deepEqual(fetched, [
    { name: "image-1.png", bytes: PNG, mediaType: "image/png" },
    { name: "report.pdf", bytes: bytes("%PDF-1.7"), mediaType: "application/pdf" },
  ]);
  assert.equal(seen[0]?.headers["authorization"], "Bearer bot-token");
  assert.ok(seen[1] !== undefined && !("authorization" in seen[1].headers));
});

const refusals: readonly (readonly [string, InboundFile, Tokens | null, string])[] = [
  ["a look-alike host", pasted("https://attacker.trafficmanager.net/x"), new Tokens(), "it is not on a Teams address"],
  ["plain http to teams", pasted("http://smba.trafficmanager.net/x"), new Tokens(), "it is not on a Teams address"],
  ["no token source", pasted(), null, "this worker has no Teams token to fetch it with"],
  ["the token source fails", pasted(), new Tokens(true), "Teams did not give me a token to fetch it with"],
  ["a plain http file link", sent("a.pdf", "http://example.test/a.pdf"), new Tokens(), "its link is not https"],
];

for (const [label, file, tokens, why] of refusals) {
  test(`the bots token goes to teams and nowhere else: ${label}`, async () => {
    const { files, seen } = fetcher(() => ({ body: X }), tokens);
    const { fetched, failed } = await files.fetchAll([file]);
    assert.deepEqual(fetched, []);
    assert.deepEqual(failed, [{ name: file.name || "image 1", reason: why }]);
    assert.deepEqual(seen, [], "nothing was requested");
  });
}

test("a token source failure is logged by its kind only", async () => {
  const logger = new RecordingLogger();
  const { files } = fetcher(() => ({ body: PNG }), new Tokens(true), { logger });
  await files.fetchAll([pasted()]);
  assert.deepEqual(logger.lines, [
    { level: "warn", message: "no bot token for an attachment", fields: { errorName: "RangeError" } },
  ]);
});

test("a file that fails or is too large is named and the others still go", async () => {
  const answers: Record<string, { status: number; body?: Uint8Array }> = {
    "/big": { status: 200, body: bytes("x".repeat(11)) },
    "/gone": { status: 404 },
    "/ok": { status: 200, body: bytes("fine") },
  };
  const { files } = fetcher((url) => answers[url.pathname] ?? { status: 500 }, new Tokens(), { maxFileBytes: 10 });
  const { fetched, failed } = await files.fetchAll([
    sent("big.log", "https://x.test/big"),
    sent("gone.txt", "https://x.test/gone"),
    sent("ok.txt", "https://x.test/ok"),
  ]);
  assert.deepEqual(
    fetched.map((g) => g.name),
    ["ok.txt"],
  );
  assert.deepEqual(failed, [
    { name: "big.log", reason: "it is larger than 0 MB" },
    { name: "gone.txt", reason: "Teams answered 404" },
  ]);
});

test("the size limit is counted across chunks and the default is 25 MB", async () => {
  const mb = 1024 * 1024;
  const chunk = new Uint8Array(mb);
  const stream = (count: number): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < count; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
  const fetch = (url: string): Promise<Response> =>
    Promise.resolve(new Response(stream(url.endsWith("/big") ? 26 : 25)));
  const files = new TeamsFileFetcher({ fetch, clock: new FakeClock() });
  const { fetched, failed } = await files.fetchAll([
    sent("big.bin.gz", "https://x.test/big"),
    sent("fits.gz", "https://x.test/fits"),
  ]);
  assert.deepEqual(failed, [{ name: "big.bin.gz", reason: "it is larger than 25 MB" }]);
  const [fits] = fetched;
  assert.ok(fits);
  assert.equal(fits.bytes.byteLength, 25 * mb);
  assert.equal(fits.mediaType, "application/octet-stream");
});

test("at most ten files are taken from one message", async () => {
  const { files, seen } = fetcher(() => ({ body: X }));
  const many = Array.from({ length: 12 }, (_, i) => sent(`f${String(i)}.txt`, `https://x.test/${String(i)}`));
  const { fetched, failed } = await files.fetchAll(many);
  assert.equal(fetched.length, 10);
  assert.equal(seen.length, 10);
  assert.deepEqual(
    failed.map((f) => f.name),
    ["f10.txt", "f11.txt"],
  );
  assert.equal(failed[0]?.reason, "only 10 files are taken from one message");
});

test("two files with one name do not overwrite each other", async () => {
  const { files } = fetcher(() => ({ body: X }));
  const { fetched } = await files.fetchAll([sent("a.txt", "https://x.test/1"), sent("a.txt", "https://x.test/2")]);
  assert.deepEqual(
    fetched.map((g) => g.name),
    ["a.txt", "2-a.txt"],
  );
});

const offList: readonly (readonly [string, string])[] = [
  ["setup.exe", ""],
  ["run.ps1", ""],
  ["disk.iso", ""],
  ["macro.docm", ""],
  ["x.bat", "bat"],
  ["README", ""],
  ["report.pdf", "exe"],
  ["a.vbs", ""],
  ["b.msi", ""],
  ["c.jar", ""],
  ["d.lnk", ""],
  ["e.xlsm", "xlsm"],
  ["f.dll", ""],
];

for (const [name, type] of offList) {
  test(`a file off the allowlist is never fetched and said why: ${name}`, async () => {
    const { files, seen } = fetcher(() => ({ body: X }));
    const { fetched, failed } = await files.fetchAll([sent(name, "https://x.test/f", type)]);
    assert.deepEqual(fetched, []);
    assert.deepEqual(seen, []);
    assert.equal(failed.length, 1);
    const [only] = failed;
    assert.ok(only);
    assert.equal(only.name, name);
    assert.ok(only.reason.includes("are not taken") || only.reason.includes("without a type is not taken"));
    assert.ok(only.reason.includes("video and archives are"));
  });
}

const onList: readonly (readonly [string, string])[] = [
  ["notes.txt", ""],
  ["data.CSV", ""],
  ["Report.pdf", "pdf"],
  ["deck.pptx", "pptx"],
  ["logs.tar.gz", "gz"],
  ["shot.png", ""],
  ["train.py", "py"],
  ["Program.cs", "cs"],
  ["photo.heic", "heic"],
  ["legacy.doc", "doc"],
  ["old.xls", ""],
  ["slurm-123.out", ""],
  ["clip.mp4", "mp4"],
  ["arch.svg", ""],
];

for (const [name, type] of onList) {
  test(`a file on the allowlist is taken: ${name}`, async () => {
    const { files } = fetcher(() => ({ body: X }));
    const { fetched, failed } = await files.fetchAll([sent(name, "https://x.test/f", type)]);
    assert.deepEqual(
      fetched.map((g) => g.name),
      [name],
    );
    assert.deepEqual(failed, []);
  });
}

test("a pasted image must be an image", async () => {
  const notImage = fetcher(() => ({ body: bytes("MZ\u0090\u0000 not an image") }), new Tokens());
  const first = await notImage.files.fetchAll([pasted()]);
  assert.deepEqual(first.fetched, []);
  assert.deepEqual(first.failed, [{ name: "image 1", reason: "it is not a PNG, JPEG, GIF or WebP image" }]);
  const png = fetcher(() => ({ body: PNG }), new Tokens());
  const second = await png.files.fetchAll([pasted()]);
  assert.deepEqual(
    second.fetched.map((g) => g.name),
    ["image-1.png"],
  );
  assert.deepEqual(second.failed, []);
});

test("the media type is the content type without its parameters", async () => {
  const { files } = fetcher((url) =>
    url.pathname === "/a"
      ? { body: X, headers: { "content-type": " text/plain ; charset=utf-8" } }
      : { body: X, headers: { "content-type": ";x" } },
  );
  const { fetched } = await files.fetchAll([sent("a.txt", "https://x.test/a"), sent("b.txt", "https://x.test/b")]);
  assert.deepEqual(
    fetched.map((f) => f.mediaType),
    ["text/plain", "application/octet-stream"],
  );
});

test("an empty body is an empty file", async () => {
  const { files } = fetcher(() => ({}));
  const { fetched } = await files.fetchAll([sent("a.txt", "https://x.test/a")]);
  assert.deepEqual(fetched[0]?.bytes, new Uint8Array());
});

test("the plain http prefix is allowed for the release gate and nothing else", async () => {
  const { files, seen } = fetcher(() => ({ body: X }), null, { plainPrefix: "http://127.0.0.1:9/files/" });
  const { fetched, failed } = await files.fetchAll([
    sent("a.txt", "http://127.0.0.1:9/files/a.txt"),
    sent("b.txt", "http://127.0.0.1:9/other/b.txt"),
  ]);
  assert.deepEqual(
    fetched.map((f) => f.name),
    ["a.txt"],
  );
  assert.deepEqual(failed, [{ name: "b.txt", reason: "its link is not https" }]);
  assert.deepEqual(
    seen.map((s) => s.url),
    ["http://127.0.0.1:9/files/a.txt"],
  );
});

test("an injected host policy decides where the token goes", async () => {
  const { files, seen } = fetcher(() => ({ body: PNG }), new Tokens(), {
    hosts: onlyConnector("http://127.0.0.1:7"),
  });
  const { fetched, failed } = await files.fetchAll([pasted("http://127.0.0.1:7/v3/attachments/a"), pasted(BOT_URL)]);
  assert.deepEqual(
    fetched.map((f) => f.name),
    ["image-1.png"],
  );
  assert.deepEqual(failed, [{ name: "image 2", reason: "it is not on a Teams address" }]);
  assert.equal(seen.length, 1);
});

test("fetch file answers the surface port with a result", async () => {
  const { files } = fetcher((url) => (url.pathname === "/a" ? { body: X } : { status: 403 }));
  const [first, second] = inboundFiles(
    dm("x", [image(), fileInfo("a.txt", "https://x.test/a", "txt"), fileInfo("b.txt", "https://x.test/b", "txt")]),
  ).files.slice(1);
  assert.ok(first && second);
  assert.deepEqual(await files.fetchFile(first), {
    ok: true,
    value: { name: "a.txt", mediaType: "application/octet-stream", bytes: X },
  });
  assert.deepEqual(await files.fetchFile(second), {
    ok: false,
    error: { kind: "file_refused", reason: "Teams answered 403" },
  });
});

test("fetch file names a pasted image by its place and refuses one past the tenth", async () => {
  const { files } = fetcher(() => ({ body: PNG }));
  const third = await files.fetchFile(pasted(BOT_URL, 3));
  assert.ok(third.ok);
  assert.equal(third.value.name, "image-3.png");
  assert.deepEqual(await files.fetchFile(pasted(BOT_URL, 11)), {
    ok: false,
    error: { kind: "file_refused", reason: "only 10 files are taken from one message" },
  });
});

test("a file whose handle is not a teams handle is refused without a request", async () => {
  const { files, seen } = fetcher(() => ({ body: X }));
  const foreign: InboundFile = { name: "a.txt", type: "txt", handle: { url: 5 } };
  assert.deepEqual(await files.fetchFile(foreign), {
    ok: false,
    error: { kind: "file_refused", reason: "it is not a file this worker can fetch" },
  });
  assert.deepEqual(seen, []);
});

test("a file is shown by its name, a pasted image by its place", () => {
  assert.equal(shownFileName(sent("a.txt", "https://x.test/a"), 4), "a.txt");
  assert.equal(shownFileName(pasted(), 4), "image 4");
});
