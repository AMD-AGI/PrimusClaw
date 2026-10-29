// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A scripted identity service for the device flow and the refresh grant (RFC 8628, RFC 6749 section 6). */
import http from "node:http";
import type { AddressInfo } from "node:net";

export class FakeIdentity {
  url = "";
  /** What each poll of the device grant answers, in order; the last repeats. */
  pollScript: Array<"authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "ok"> = ["ok"];
  interval = 1;
  expiresIn = 600;
  polls: number[] = [];
  readonly requests: Array<{ path: string; form: Record<string, string> }> = [];
  refreshTokens = new Set<string>();
  accessCounter = 0;
  revokedTokens: string[] = [];
  /** Make the next refresh answer this error. */
  refreshError: string | null = null;
  private server!: http.Server;

  static async start(): Promise<FakeIdentity> {
    const f = new FakeIdentity();
    f.server = http.createServer((req, res) => void f.handle(req, res));
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
  }

  async close(): Promise<void> { await new Promise<void>((r) => { this.server.close(() => r()); this.server.closeAllConnections(); }); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    const path = new URL(req.url ?? "/", "http://x").pathname;
    this.requests.push({ path, form });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/oauth/device_authorization") {
      return send(200, {
        device_code: "dev-code-1", user_code: "ABCD-EFGH", verification_uri: `${this.url}/device`, verification_uri_complete: `${this.url}/device?user_code=ABCD-EFGH`,
        expires_in: this.expiresIn, interval: this.interval,
      });
    }
    if (path === "/oauth/token" && form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      this.polls.push(Date.now());
      const step = this.pollScript[Math.min(this.polls.length - 1, this.pollScript.length - 1)]!;
      if (step === "ok") { const rt = `refresh-${++this.accessCounter}`; this.refreshTokens.add(rt); return send(200, { access_token: `access-${this.accessCounter}`, token_type: "Bearer", expires_in: 300, refresh_token: rt, scope: "claw.connector" }); }
      return send(400, { error: step });
    }
    if (path === "/oauth/token" && form.grant_type === "refresh_token") {
      if (this.refreshError) return send(400, { error: this.refreshError });
      if (!this.refreshTokens.has(form.refresh_token ?? "")) return send(400, { error: "invalid_grant" });
      this.refreshTokens.delete(form.refresh_token!);
      const rt = `refresh-${++this.accessCounter}`;
      this.refreshTokens.add(rt);
      return send(200, { access_token: `access-${this.accessCounter}`, token_type: "Bearer", expires_in: 300, refresh_token: rt });
    }
    if (path === "/oauth/revoke") { this.revokedTokens.push(form.token ?? ""); this.refreshTokens.delete(form.token ?? ""); return send(200, {}); }
    return send(404, { error: "not_found" });
  }
}
