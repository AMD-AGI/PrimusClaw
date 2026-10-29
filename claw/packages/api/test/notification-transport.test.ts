// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The real transport against a local server that misbehaves. The deadline is
 * on the whole exchange: a socket idle timeout never fires for a receiver that
 * sends a byte every so often.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { httpTransport } from "../src/notifications/transport.js";

const target = (port: number) => ({
  ok: true as const, url: new URL(`http://127.0.0.1:${port}/hook`), address: "127.0.0.1", family: 4 as const,
});
const listen = (onConn: (s: net.Socket) => void) => new Promise<net.Server>((resolve) => {
  const srv = net.createServer(onConn).listen(0, "127.0.0.1", () => resolve(srv));
});

test("a receiver that trickles bytes without ever finishing its response is cut off at the deadline", async () => {
  const timers: NodeJS.Timeout[] = [];
  const srv = await listen((sock) => {
    sock.on("data", () => {
      // Valid header lines, one at a time, never the blank line that ends them:
      // the socket is never idle for long and the response never completes.
      sock.write("HTTP/1.1 200 OK\r\n");
      timers.push(setInterval(() => sock.write("x-h: v\r\n"), 100));
    });
    sock.on("error", () => {});
  });
  const started = Date.now();
  try {
    await assert.rejects(
      httpTransport({ target: target((srv.address() as net.AddressInfo).port), headers: {}, body: "{}", timeoutMs: 600 }),
      /deadline/,
    );
    const took = Date.now() - started;
    assert.ok(took >= 550 && took < 1500, `cut off after ${took}ms`);
  } finally {
    timers.forEach(clearInterval);
    srv.close();
  }
});

test("a normal receiver gets its status back and a trickled body after the status does not hold the call", async () => {
  const timers: NodeJS.Timeout[] = [];
  const srv = await listen((sock) => {
    sock.on("data", () => {
      sock.write("HTTP/1.1 202 Accepted\r\ncontent-length: 100000\r\n\r\n");
      timers.push(setInterval(() => sock.write("y"), 100));
    });
    sock.on("error", () => {});
  });
  try {
    const code = await httpTransport({ target: target((srv.address() as net.AddressInfo).port), headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(code, 202);
  } finally {
    timers.forEach(clearInterval);
    srv.close();
  }
});
