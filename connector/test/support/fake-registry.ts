// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in npm registry over real HTTP, serving tarballs from files: enough for `npm install`, `npm view` and the integrity
 * check npm makes on every tarball (sha512 in the packument). It records what was asked, so a test can tell that a version was
 * never downloaded.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface Entry { file: string; integrity: string; shasum: string; manifest: Record<string, unknown> }

export class FakeRegistry {
  url = "";
  private server!: http.Server;
  private readonly packages = new Map<string, Map<string, Entry>>();
  /** Every request, as `METHOD path`. */
  readonly requests: string[] = [];

  static async start(): Promise<FakeRegistry> {
    const r = new FakeRegistry();
    r.server = http.createServer((req, res) => r.handle(req, res));
    await new Promise<void>((ok) => r.server.listen(0, "127.0.0.1", ok));
    r.url = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/`;
    return r;
  }

  /** Serve `file` (an npm tarball) as `name@version`, with the manifest it was packed with. */
  add(manifest: Record<string, unknown> & { name: string; version: string }, file: string): void {
    const bytes = fs.readFileSync(file);
    const entry: Entry = {
      file, manifest,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    };
    const versions = this.packages.get(manifest.name) ?? new Map<string, Entry>();
    versions.set(manifest.version, entry);
    this.packages.set(manifest.name, versions);
  }

  /** How many times the tarball of `name@version` was downloaded. */
  downloads(name: string, version: string): number {
    return this.requests.filter((r) => r === `GET ${this.tarballPath(name, version)}`).length;
  }

  private tarballPath(name: string, version: string): string {
    return `/-/t/${encodeURIComponent(name)}/${version}.tgz`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const p = (req.url ?? "/").split("?")[0]!;
    this.requests.push(`${req.method} ${p}`);
    const t = /^\/-\/t\/([^/]+)\/([^/]+)\.tgz$/.exec(p);
    if (t) {
      const e = this.packages.get(decodeURIComponent(t[1]!))?.get(t[2]!);
      if (!e) return this.send(res, 404, { error: "not_found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      fs.createReadStream(e.file).pipe(res);
      return;
    }
    const name = decodeURIComponent(p.slice(1));
    const versions = this.packages.get(name);
    if (!versions) return this.send(res, 404, { error: "not_found" });
    const all = [...versions.keys()];
    this.send(res, 200, {
      name, "dist-tags": { latest: all[all.length - 1] },
      versions: Object.fromEntries([...versions].map(([v, e]) => [v, {
        ...e.manifest, _id: `${name}@${v}`, dist: { tarball: `${this.url.replace(/\/$/, "")}${this.tarballPath(name, v)}`, integrity: e.integrity, shasum: e.shasum },
      }])),
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }
}
