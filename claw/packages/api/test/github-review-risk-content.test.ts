// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The high-risk rule pack judged by what a change DOES, with real unified diffs as GitHub sends
 * them (one `patch` per file, hunks only). Every row is a change a reviewer would recognise:
 *
 *   architecture   a package or a deployable unit appears or goes, a directory moves, the layering changes
 *   interface      an exported signature, an HTTP route, a schema, a CLI flag, an environment contract, a database schema, a wire format
 *   security       code that decides who may do what, cryptography, secrets, privileges
 *   release        a pipeline, an image, a release script: when its content changed, not when someone touched a comment
 *   low            a pure refactor, a move of code, a reformat, a body-only change, documentation, tests: these must NOT be held
 *   judgement      the reviewing model can raise a verdict with a short reason, never lower it
 *
 * The low rows matter as much as the high ones: a rule pack that holds everything is a confirmation nobody reads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_JUDGEMENT_REASON_CHARS, RISK_RULE_PACK_VERSION, assessRisk, normaliseJudgement, type RiskCategory, type RiskFile, type RiskInput } from "../src/github-review/risk.js";

const counts = (patch: string): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk && l.startsWith("+")) additions++;
    if (inHunk && l.startsWith("-")) deletions++;
  }
  return { additions, deletions };
};
const mod = (path: string, patch: string, over: Partial<RiskFile> = {}): RiskFile => ({ path, status: "modified", ...counts(patch), patch, ...over });
const added = (path: string, patch: string): RiskFile => mod(path, patch, { status: "added" });
const removed = (path: string, patch: string): RiskFile => mod(path, patch, { status: "removed" });
const renamed = (from: string, to: string, patch = "@@ -1,2 +1,2 @@\n-// moved\n+// moved here\n x"): RiskFile => mod(to, patch, { status: "renamed", previousPath: from });
const input = (files: RiskFile[], over: Partial<RiskInput> = {}): RiskInput => ({
  files, changedFiles: files.length, filesComplete: true,
  additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
  fork: false, authorAssociation: "MEMBER", baseRef: "main", defaultBranch: "main", repoConfig: null, ...over,
});

// ------------------------------------------------------------------------------------------------------------ low

/** Moves a function between files, byte for byte (the other half of the diff is in `utilFormat`). */
const formatBefore = `@@ -1,19 +1,9 @@
 import { Row } from "./types.js";

-export function formatBytes(n: number): string {
-  if (n < 1024) return \`\${n} B\`;
-  const units = ["KiB", "MiB", "GiB"];
-  let i = -1;
-  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
-  return \`\${n.toFixed(1)} \${units[i]}\`;
-}
-
 export function total(rows: Row[]): number {
   return rows.reduce((n, r) => n + r.amount, 0);
 }`;
const utilFormat = `@@ -0,0 +1,8 @@
+export function formatBytes(n: number): string {
+  if (n < 1024) return \`\${n} B\`;
+  const units = ["KiB", "MiB", "GiB"];
+  let i = -1;
+  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
+  return \`\${n.toFixed(1)} \${units[i]}\`;
+}
+`;

const LOW: Array<[string, RiskFile[]]> = [
  ["a pure refactor: a loop body extracted into a private helper, locals renamed, no signature touched", [mod("src/render/card.ts", `@@ -41,12 +41,16 @@ export function renderCard(items: Item[]): Card {
   const rows: Row[] = [];
-  for (const it of items) {
-    const label = it.title.trim().slice(0, 80);
-    rows.push({ label, url: it.url });
-  }
+  for (const it of items) {
+    rows.push(toRow(it));
+  }
   return { rows, count: rows.length };
 }
+
+function toRow(it: Item): Row {
+  const label = it.title.trim().slice(0, 80);
+  return { label, url: it.url };
+}`)]],
  ["a function, exported and all, moved from one file to another unchanged", [mod("src/format.ts", formatBefore), added("src/util/format.ts", utilFormat)]],
  ["route registrations and an environment read moved to another file, line for line", [
    mod("src/routes/health.ts", `@@ -3,8 +3,3 @@ import { FastifyInstance } from "fastify";
 export async function registerHealth(app: FastifyInstance): Promise<void> {
-  app.get("/health", async () => ({ ok: true }));
-  app.get("/ready", async () => ({ ready: await db.ping() }));
-  const probe = process.env.CLAW_PROBE_URL;
 }`),
    mod("src/routes/probes.ts", `@@ -1,3 +1,6 @@ import { FastifyInstance } from "fastify";
 export async function registerProbes(app: FastifyInstance): Promise<void> {
+  app.get("/health", async () => ({ ok: true }));
+  app.get("/ready", async () => ({ ready: await db.ping() }));
+  const probe = process.env.CLAW_PROBE_URL;
 }`),
  ]],
  ["a body-only change to an exported function: its signature line is context", [mod("src/money.ts", `@@ -12,7 +12,7 @@ import { Row } from "./types.js";
 export function total(rows: Row[]): number {
-  return rows.reduce((n, r) => n + r.amount, 0);
+  return rows.reduce((n, r) => n + Number(r.amount), 0);
 }`)]],
  ["an exported constant whose value changed (its declaration did not)", [mod("src/limits.ts", `@@ -3,4 +3,4 @@
-export const MAX_RETRIES = 3;
+export const MAX_RETRIES = 5;
 export const RETRY_DELAY_MS = 250;`)]],
  ["the signature of a function that is not exported", [mod("src/render/card.ts", `@@ -60,7 +60,7 @@
-function clip(text: string): string {
+function clip(text: string, max = 80): string {
   return text.slice(0, max);
 }`)]],
  ["a new exported helper in an ordinary module", [mod("src/strings.ts", `@@ -20,3 +20,7 @@ export function slug(s: string): string {
   return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
 }
+
+export function initials(name: string): string {
+  return name.split(" ").map((p) => p[0]).join("");
+}`)]],
  ["a new module with its own exports", [added("src/pricing.ts", `@@ -0,0 +1,6 @@
+export interface Price { amount: number; currency: string }
+
+export function discount(p: Price, pct: number): Price {
+  return { ...p, amount: p.amount * (1 - pct / 100) };
+}`)]],
  ["a reformat of a Go file, exported function included (whitespace only)", [mod("pkg/queue/queue.go", `@@ -10,5 +10,5 @@ import "sync"
-func (q *Queue) Push(item Item)   error {
-	q.mu.Lock(); defer q.mu.Unlock()
-	return q.push(item)
-}
+func (q *Queue) Push(item Item) error {
+	q.mu.Lock()
+	defer q.mu.Unlock()
+	return q.push(item)
+}`)]],
  ["a one-file rename inside the same package", [renamed("src/render/card.ts", "src/render/cards.ts", "@@ -1,3 +1,3 @@\n-import { x } from \"./a.js\";\n+import { x } from \"./b.js\";\n y")]],
  ["a comment-only change in an authentication module", [mod("src/auth/session.ts", `@@ -8,5 +8,5 @@
-// Sessions last a day.
+// Sessions last one day; see docs/sessions.md.
 const TTL = 86400;`)]],
  ["a comment-only change to a Dockerfile", [mod("Dockerfile", `@@ -1,3 +1,3 @@
-# build image
+# build image (node 26)
 FROM node:26-slim`)]],
  ["documentation that talks about auth, routes, flags and environment variables", [mod("docs/auth.md", `@@ -4,2 +4,5 @@
 Sign in with an access token.
+The API reads CLAW_AUTH_MODE from process.env.CLAW_AUTH_MODE and exposes app.get("/v1/me").
+Pass --insecure only in development; run ALTER TABLE users ADD COLUMN x by hand.
+export function authorize(token: string): boolean`), mod("README.md", "@@ -1 +1,2 @@\n # demo\n+see the docs")]],
  ["a test that registers a route, reads the environment and checks a permission", [mod("test/routes.test.ts", `@@ -5,3 +5,9 @@
 test("health", async () => {
+  process.env.CLAW_AUTH_MODE = "off";
+  app.get("/v1/probe", async () => ({ ok: true }));
+  assert.equal(await hasPermission(user, "read"), true);
+  assert.equal(await app.inject("/v1/probe").status, 200);
 });`), mod("src/__tests__/auth.test.ts", "@@ -1,2 +1,3 @@\n a\n+jwt.verify(token, key)")]],
  ["a small bug fix: one condition", [mod("src/queue/drain.ts", `@@ -31,7 +31,7 @@ async function drain(q: Queue): Promise<void> {
-  while (q.length > 1) {
+  while (q.length > 0) {
     await q.next();
   }`)]],
  ["a source file with a word that only looks like a keyword", [mod("src/author.ts", `@@ -1,2 +1,2 @@
-const byline = "written by";
+const byline = "authored by";`)]],
];
for (const [name, files] of LOW) {
  test(`low: ${name}`, () => {
    const r = assessRisk(input(files));
    assert.deepEqual(r.reasons, [], r.reasons.join("\n"));
    assert.equal(r.level, "low");
    assert.equal(r.ruleLevel, "low");
  });
}

// ----------------------------------------------------------------------------------------------------------- high

interface Row { name: string; files: RiskFile[]; category: RiskCategory; why: RegExp; over?: Partial<RiskInput> }
const HIGH: Row[] = [
  // ---- architecture
  { name: "a new package", category: "architecture", why: /package or module was added \(packages\/billing\/package\.json\)/, files: [
    added("packages/billing/package.json", `@@ -0,0 +1,8 @@
+{
+  "name": "@claw/billing",
+  "version": "0.1.0",
+  "type": "module",
+  "main": "dist/index.js"
+}`),
    added("packages/billing/src/index.ts", "@@ -0,0 +1,2 @@\n+export const billing = true;\n+"),
  ] },
  { name: "a package removed", category: "architecture", why: /package or module was removed \(packages\/legacy\/package\.json\)/, files: [
    removed("packages/legacy/package.json", "@@ -1,5 +0,0 @@\n-{\n-  \"name\": \"@claw/legacy\",\n-  \"version\": \"0.0.1\"\n-}"),
  ] },
  { name: "a Go module added", category: "architecture", why: /package or module was added \(tools\/ctl\/go\.mod\)/, files: [
    added("tools/ctl/go.mod", "@@ -0,0 +1,3 @@\n+module example.invalid/ctl\n+\n+go 1.24"),
  ] },
  { name: "a directory moved: four handlers go under api/", category: "architecture", why: /4 files moved src\/handlers\/ -> src\/api\/handlers\//, files: [
    renamed("src/handlers/a.ts", "src/api/handlers/a.ts"), renamed("src/handlers/b.ts", "src/api/handlers/b.ts"),
    renamed("src/handlers/c.ts", "src/api/handlers/c.ts"), renamed("src/handlers/d.ts", "src/api/handlers/d.ts"),
  ] },
  { name: "code moved from one package to another", category: "architecture", why: /moved between packages packages\/api\/ -> packages\/utils\//, files: [
    renamed("packages/api/src/util/ids.ts", "packages/utils/src/ids.ts"),
  ] },
  { name: "a new service: a Deployment and its image", category: "architecture", why: /Kubernetes Deployment added \(deploy\/charts\/app\/templates\/worker-deployment\.yaml\)/, files: [
    added("deploy/charts/app/templates/worker-deployment.yaml", `@@ -0,0 +1,14 @@
+apiVersion: apps/v1
+kind: Deployment
+metadata:
+  name: {{ .Release.Name }}-worker
+spec:
+  replicas: 1
+  template:
+    spec:
+      containers:
+        - name: worker
+          image: "{{ .Values.image }}"`),
    added("services/worker/Dockerfile", "@@ -0,0 +1,3 @@\n+FROM node:26-slim\n+COPY . /app\n+CMD [\"node\", \"/app/index.js\"]"),
  ] },
  { name: "a deployable unit removed", category: "architecture", why: /deployable unit was removed \(services\/legacy\/Dockerfile\)/, files: [
    removed("services/legacy/Dockerfile", "@@ -1,2 +0,0 @@\n-FROM node:20\n-CMD [\"node\", \"x.js\"]"),
  ] },
  { name: "infrastructure added in Terraform", category: "architecture", why: /infrastructure resource aws_sqs_queue added/, files: [
    mod("infra/queues.tf", `@@ -10,3 +10,7 @@ resource "aws_sqs_queue" "jobs" {
   name = "jobs"
 }
+
+resource "aws_sqs_queue" "dead_letters" {
+  name = "dead-letters"
+}`),
  ] },
  { name: "an import that reaches into another package", category: "architecture", why: /import reaches into another package: packages\/api\/src\/routes\/run\.ts \(\.\.\/\.\.\/\.\.\/brain\/src\/loop\.js\)/, files: [
    mod("packages/api/src/routes/run.ts", `@@ -1,4 +1,5 @@
 import { FastifyInstance } from "fastify";
+import { runLoop } from "../../../brain/src/loop.js";
 import { db } from "../infra/db.js";`),
  ] },
  { name: "the workspace layout changed", category: "architecture", why: /workspace, layering or module-boundary rules changed \(package\.json\)/, files: [
    mod("package.json", `@@ -4,5 +4,6 @@
   "private": true,
   "workspaces": [
     "packages/*",
+    "services/*"
   ]`),
  ] },
  { name: "the TypeScript project references changed", category: "architecture", why: /layering or module-boundary rules changed \(tsconfig\.json\)/, files: [
    mod("tsconfig.json", `@@ -3,3 +3,4 @@
   "references": [
     { "path": "./packages/utils" },
+    { "path": "./packages/billing" }
   ]`),
  ] },
  { name: "a lint rule that fences the layers was relaxed", category: "architecture", why: /layering or module-boundary rules changed \(\.eslintrc\.cjs\)/, files: [
    mod(".eslintrc.cjs", `@@ -9,4 +9,3 @@ module.exports = {
   rules: {
-    "no-restricted-imports": ["error", { patterns: ["**/infra/*"] }],
     "no-console": "warn",
   },`),
  ] },
  { name: "a change spread over five packages", category: "size_breadth", why: /broad change: it spans 5 packages/, files: [
    mod("packages/a/src/x.ts", "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;"), mod("packages/b/src/x.ts", "@@ -1 +1 @@\n-const b = 1;\n+const b = 2;"),
    mod("packages/c/src/x.ts", "@@ -1 +1 @@\n-const c = 1;\n+const c = 2;"), mod("packages/d/src/x.ts", "@@ -1 +1 @@\n-const d = 1;\n+const d = 2;"),
    mod("packages/e/src/x.ts", "@@ -1 +1 @@\n-const e = 1;\n+const e = 2;"),
  ] },

  // ---- interface: exported signatures
  { name: "an exported TypeScript function gets a parameter", category: "interface", why: /exported renderCard has a different signature \(src\/render\/card\.ts\)/, files: [
    mod("src/render/card.ts", `@@ -38,7 +38,7 @@ import { Item, Row } from "./types.js";
-export function renderCard(items: Item[]): Card {
+export function renderCard(items: Item[], theme: Theme): Card {
   const rows: Row[] = [];`),
  ] },
  { name: "an exported TypeScript function is removed", category: "interface", why: /exported formatBytes removed \(src\/format\.ts\)/, files: [
    mod("src/format.ts", `@@ -1,10 +1,3 @@
-export function formatBytes(n: number): string {
-  return \`\${n} B\`;
-}
-
 export function total(rows: number[]): number {`),
  ] },
  { name: "an exported arrow function changes its parameters", category: "interface", why: /exported parse has a different signature/, files: [
    mod("src/parse.ts", `@@ -2,3 +2,3 @@
-export const parse = (text: string): Doc => {
+export const parse = (text: string, strict: boolean): Doc => {
   return build(text);`),
  ] },
  { name: "an exported type alias is rewritten", category: "interface", why: /exported Status has a different signature/, files: [
    mod("src/types.ts", `@@ -7,1 +7,1 @@
-export type Status = "open" | "closed";
+export type Status = "open" | "closed" | "merged";`),
  ] },
  { name: "a file of exported symbols is deleted", category: "interface", why: /exported retry removed \(src\/retry\.ts, file deleted\)/, files: [
    removed("src/retry.ts", `@@ -1,5 +0,0 @@
-export async function retry<T>(fn: () => Promise<T>): Promise<T> {
-  return fn();
-}`),
  ] },
  { name: "a new export in a package's entry point", category: "interface", why: /new public export billing in packages\/utils\/src\/index\.ts/, files: [
    mod("packages/utils/src/index.ts", `@@ -3,3 +3,4 @@
 export * from "./async.js";
 export * from "./identity/index.js";
+export const billing = true;`),
  ] },
  { name: "a Go method changes its signature", category: "interface", why: /exported Queue\.Push has a different signature \(pkg\/queue\/queue\.go\)/, files: [
    mod("pkg/queue/queue.go", `@@ -22,7 +22,7 @@ type Queue struct {
-func (q *Queue) Push(item Item) error {
+func (q *Queue) Push(ctx context.Context, item Item) error {
 	q.mu.Lock()`),
  ] },
  { name: "a Python function changes its signature", category: "interface", why: /exported fetch_all has a different signature/, files: [
    mod("client/api.py", `@@ -14,4 +14,4 @@ import httpx
-def fetch_all(base: str, limit: int = 100) -> list[dict]:
+def fetch_all(base: str, limit: int = 100, *, timeout: float = 30.0) -> list[dict]:
     return _page(base, limit)`),
  ] },
  { name: "a Rust pub function changes its signature", category: "interface", why: /exported decode has a different signature/, files: [
    mod("src/codec.rs", `@@ -3,4 +3,4 @@
-pub fn decode(input: &[u8]) -> Result<Frame, Error> {
+pub fn decode(input: &[u8], limit: usize) -> Result<Frame, Error> {
     parse(input)`),
  ] },
  { name: "a Java public method changes its signature", category: "interface", why: /exported charge has a different signature/, files: [
    mod("src/main/java/com/example/Billing.java", `@@ -20,4 +20,4 @@
-    public Receipt charge(Customer c, Money amount) {
+    public Receipt charge(Customer c, Money amount, Currency cur) {
         return gateway.charge(c, amount);`),
  ] },

  // ---- interface: routes, schemas, flags, environment, database, wire
  { name: "an HTTP route is added", category: "interface", why: /HTTP route POST \/v1\/orders added, removed or changed \(src\/routes\/orders\.ts\)/, files: [
    added("src/routes/orders.ts", `@@ -0,0 +1,6 @@
+export async function registerOrders(app: FastifyInstance): Promise<void> {
+  app.post("/v1/orders", async (req, reply) => {
+    return reply.code(201).send(await create(req.body));
+  });
+}`),
  ] },
  { name: "an HTTP route is removed", category: "interface", why: /HTTP route GET \/v1\/legacy\/ping added, removed or changed/, files: [
    mod("src/routes/health.ts", `@@ -9,7 +9,3 @@ export async function registerHealth(app: FastifyInstance): Promise<void> {
   app.get("/health", async () => ({ ok: true }));
-  app.get("/v1/legacy/ping", async () => ({ pong: 1 }));
 }`),
  ] },
  { name: "a route registered with a decorator", category: "interface", why: /HTTP route POST \/items added/, files: [
    mod("service/main.py", `@@ -30,3 +30,7 @@ async def list_items():
     return items
+
+@router.post("/items")
+async def create_item(body: Item):
+    return store(body)`),
  ] },
  { name: "a Go handler registered on a mux", category: "interface", why: /HTTP route \/healthz added/, files: [
    mod("cmd/server/main.go", `@@ -41,3 +41,4 @@ func routes() http.Handler {
 	mux := http.NewServeMux()
+	mux.HandleFunc("/healthz", health)
 	return mux`),
  ] },
  { name: "an OpenAPI document changes", category: "interface", why: /API or data schema definition changed \(api\/openapi\.yaml\)/, files: [
    mod("api/openapi.yaml", `@@ -88,6 +88,12 @@ paths:
   /v1/orders:
     get:
       summary: List orders
+    post:
+      summary: Create an order
+      requestBody:
+        required: true`),
  ] },
  { name: "a protobuf message gains a field", category: "interface", why: /API or data schema definition changed \(proto\/order\.proto\)/, files: [
    mod("proto/order.proto", `@@ -7,4 +7,5 @@ message Order {
   string id = 1;
   int64 total_cents = 2;
+  string currency = 3;
 }`),
  ] },
  { name: "a GraphQL type changes", category: "interface", why: /schema definition changed \(schema\.graphql\)/, files: [
    mod("schema.graphql", `@@ -2,3 +2,3 @@ type Order {
-  total: Int!
+  total: Float!
   id: ID!`),
  ] },
  { name: "a command-line flag is added (commander)", category: "interface", why: /command-line flag --dry-run added, removed or changed \(cli\/main\.ts\)/, files: [
    mod("cli/main.ts", `@@ -11,3 +11,4 @@ program
   .option("--api <url>", "API address")
+  .option("--dry-run", "check everything, write nothing")
   .action(run);`),
  ] },
  { name: "a command-line flag is added (Go flag)", category: "interface", why: /command-line flag -timeout added/, files: [
    mod("cmd/ctl/main.go", `@@ -18,3 +18,4 @@ func main() {
 	addr := flag.String("addr", ":8080", "listen address")
+	timeout := flag.Duration("timeout", 30*time.Second, "request timeout")
 	flag.Parse()`),
  ] },
  { name: "a command-line flag is added (argparse)", category: "interface", why: /command-line flag --retries added/, files: [
    mod("tools/run.py", `@@ -9,2 +9,3 @@ def main():
     parser.add_argument("--api", required=True)
+    parser.add_argument("--retries", type=int, default=3)`),
  ] },
  { name: "a new environment variable is read", category: "interface", why: /environment CLAW_BILLING_URL added, removed or changed \(src\/config\.ts\)/, files: [
    mod("src/config.ts", `@@ -41,3 +41,4 @@
 export const PORT = envInt("PORT", 8200);
+export const BILLING_URL = process.env.CLAW_BILLING_URL;
 export const HOST = "0.0.0.0";`),
  ] },
  { name: "an environment variable a Go program read is dropped", category: "interface", why: /environment ORDER_QUEUE added, removed or changed/, files: [
    mod("cmd/worker/main.go", `@@ -12,5 +12,4 @@ func main() {
-	queue := os.Getenv("ORDER_QUEUE")
 	conc := os.Getenv("CONCURRENCY")`),
  ] },
  { name: "the documented configuration example changes", category: "interface", why: /documented configuration contract changed \(\.env\.example\)/, files: [
    mod(".env.example", "@@ -3,2 +3,3 @@\n PORT=8200\n+BILLING_URL=\n LOG_LEVEL=info"),
  ] },
  { name: "a database migration is added", category: "interface", why: /database migration changed \(db\/migrations\/0042_orders\.sql\)/, files: [
    added("db/migrations/0042_orders.sql", `@@ -0,0 +1,5 @@
+CREATE TABLE orders (
+  id UUID PRIMARY KEY,
+  total_cents BIGINT NOT NULL
+);`),
  ] },
  { name: "a column is added from application code", category: "interface", why: /database schema statement added, removed or changed \(src\/infra\/db\.ts\)/, files: [
    mod("src/infra/db.ts", `@@ -2250,3 +2250,4 @@ async function ensureSchema(client: PoolClient): Promise<void> {
   await client.query("CREATE INDEX IF NOT EXISTS idx_a ON a(b)");
+  await client.query("ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS region TEXT");
 }`),
  ] },
  { name: "a field of the wire format is renamed", category: "interface", why: /wire, event or contract definition changed \(packages\/protocol\/src\/events\.ts\)/, files: [
    mod("packages/protocol/src/events.ts", `@@ -30,4 +30,4 @@ export interface RunFinished {
   type: "RunFinished";
-  sessionId: string;
+  session_id: string;
 }`),
  ] },
  { name: "a JSON schema file", category: "interface", why: /API or data schema definition changed \(schemas\/app-manifest\.json\)/, files: [
    mod("schemas/app-manifest.json", `@@ -12,3 +12,4 @@
   "properties": {
     "name": { "type": "string" },
+    "entry": { "type": "string" }
   }`),
  ] },

  // ---- security-sensitive code
  { name: "an authentication middleware changes", category: "security", why: /authentication or security code changed: src\/auth\/middleware\.ts/, files: [
    mod("src/auth/middleware.ts", `@@ -120,7 +120,7 @@ export async function authMiddleware(req: FastifyRequest): Promise<void> {
-  if (!token) return reject(req, 401);
+  if (!token && !isInternal(req)) return reject(req, 401);
   const user = await verify(token);`),
  ] },
  { name: "a permission check is removed", category: "security", why: /security-sensitive code: authorization or permission logic changed \(src\/routes\/admin\.ts\)/, files: [
    mod("src/routes/admin.ts", `@@ -44,6 +44,5 @@ async function dropTenant(req: FastifyRequest, reply: FastifyReply) {
-  if (!isAdmin(req.user)) return reply.code(403).send({ error: "forbidden" });
   await store.drop(req.params.id);`),
  ] },
  { name: "the way a signature is computed changes", category: "security", why: /security-sensitive code: cryptography changed \(src\/webhook\/sign\.ts\)/, files: [
    mod("src/webhook/sign.ts", `@@ -5,4 +5,4 @@ import { createHmac } from "node:crypto";
 function sign(body: string, key: string): string {
-  return createHmac("sha256", key).update(body).digest("hex");
+  return createHmac("sha1", key).update(body).digest("hex");
 }`),
  ] },
  { name: "a token comparison is no longer constant-time", category: "security", why: /security-sensitive code: cryptography changed \(src\/hooks\/verify\.ts\)/, files: [
    mod("src/hooks/verify.ts", `@@ -9,3 +9,3 @@ export function verifyHook(given: string, want: string): boolean {
-  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
+  return given === want;
 }`),
  ] },
  { name: "a secret-bearing environment variable is read", category: "security", why: /secret-bearing environment variable STRIPE_SECRET_KEY \(src\/billing\.ts\)/, files: [
    mod("src/billing.ts", `@@ -1,3 +1,4 @@
 import Stripe from "stripe";
+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
 export {};`),
  ] },
  { name: "a container asks for privileges", category: "security", why: /security-sensitive code: privilege or isolation settings changed \(deploy\/pod\.yaml\)/, files: [
    mod("deploy/pod.yaml", `@@ -14,3 +14,4 @@ spec:
     - name: app
+      securityContext: { privileged: true }
       image: app:1`),
  ] },
  { name: "CORS is opened to every origin", category: "security", why: /security-sensitive code: web security settings changed \(src\/server\.ts\)/, files: [
    mod("src/server.ts", `@@ -30,3 +30,3 @@
-  await app.register(cors, { origin: ["https://console.example.invalid"] });
+  await app.register(cors, { origin: true });`),
  ] },
  { name: "a shell command built from request data", category: "security", why: /security-sensitive code: code execution or injection surface changed \(src\/git\.ts\)/, files: [
    mod("src/git.ts", `@@ -10,3 +10,3 @@ export function clone(url: string): void {
-  execFileSync("git", ["clone", url]);
+  execSync(\`git clone \${url}\`);
 }`),
  ] },

  // ---- CI and release: content, not a touched comment
  { name: "a workflow step", category: "ci_release", why: /CI, workflow or governance file changed: \.github\/workflows\/release\.yml/, files: [
    mod(".github/workflows/release.yml", `@@ -22,3 +22,4 @@ jobs:
       - run: npm test
+      - run: npm publish --access public
       - run: echo done`),
  ] },
  { name: "a Dockerfile base image", category: "ci_release", why: /release or deployment file changed: Dockerfile/, files: [
    mod("Dockerfile", `@@ -1,3 +1,3 @@
-FROM node:26-slim
+FROM node:latest
 COPY . /app`),
  ] },
  { name: "a Makefile target", category: "ci_release", why: /release or deployment file changed: Makefile/, files: [
    mod("Makefile", "@@ -10,2 +10,3 @@\n release:\n+\tcurl -s https://example.invalid/x.sh | sh\n \tnpm publish"),
  ] },

  // ---- dependencies, which are an edge of the dependency graph
  { name: "a workspace dependency edge is added", category: "dependency", why: /dependency added or changed: packages\/api\/package\.json/, files: [
    mod("packages/api/package.json", `@@ -20,3 +20,4 @@
     "@claw/utils": "*",
+    "@claw/billing": "workspace:*",
     "fastify": "^5.12.5"`),
  ] },
];

for (const row of HIGH) {
  test(`high (${row.category}): ${row.name}`, () => {
    const r = assessRisk(input(row.files, row.over));
    assert.equal(r.level, "high", "a change like this is held");
    assert.equal(r.ruleLevel, "high");
    assert.match(r.reasons.join("\n"), row.why);
    assert.ok(r.categories.includes(row.category), `categories ${r.categories.join(",")} should include ${row.category}`);
    assert.equal(r.rulePack, RISK_RULE_PACK_VERSION);
  });
}

test("a removed security check cannot hide behind an identical line added somewhere else: nothing that touches security-sensitive code is cancelled", () => {
  const guard = "if (!isAdmin(req.user)) return reply.code(403).send({ error: \"forbidden\" });";
  const cases: Array<[string, RiskFile[], RegExp]> = [
    ["removed from one route, the same line added to another", [
      mod("src/routes/tenants.ts", `@@ -44,6 +44,5 @@ async function dropTenant(req: FastifyRequest, reply: FastifyReply) {\n-  ${guard}\n   await store.drop(req.params.id);`),
      mod("src/routes/reports.ts", `@@ -9,3 +9,4 @@ async function listReports(req: FastifyRequest, reply: FastifyReply) {\n+  ${guard}\n   return store.reports();`),
    ], /authorization or permission logic changed \(src\/routes\/tenants\.ts\)/],
    ["removed from a handler and added to another in the same file", [
      mod("src/routes/tenants.ts", `@@ -44,6 +44,5 @@\n-  ${guard}\n   await store.drop(req.params.id);\n@@ -90,3 +89,4 @@\n   return store.reports();\n+  ${guard}`),
    ], /authorization or permission logic changed \(src\/routes\/tenants\.ts\)/],
    ["removed from an authentication module and added to a file elsewhere", [
      mod("src/auth/gate.ts", `@@ -3,4 +3,3 @@\n-  ${guard}\n   next();`),
      mod("src/util/misc.ts", `@@ -1,2 +1,3 @@\n a\n+  ${guard}`),
    ], /authentication or security code changed: src\/auth\/gate\.ts/],
    ["a Dockerfile line removed, the same line added to another file", [
      mod("Dockerfile", "@@ -5,3 +5,2 @@\n-RUN curl -s https://example.invalid/x.sh | sh\n USER app"),
      mod("scripts/helper.sh", "@@ -1,1 +1,2 @@\n a\n+RUN curl -s https://example.invalid/x.sh | sh"),
    ], /release or deployment file changed: Dockerfile/],
  ];
  for (const [name, files, why] of cases) {
    const r = assessRisk(input(files));
    assert.equal(r.level, "high", name);
    assert.match(r.reasons.join("\n"), why, name);
  }
});

test("a very long changed line is held rather than scanned: it is minified or generated, the patterns do not read it, and reading it costs nothing", () => {
  const long = "a".repeat(200_000);
  const started = Date.now();
  const r = assessRisk(input([mod("dist/app.min.js", `@@ -1 +1 @@\n-${long}\n+${long}b`)]));
  assert.ok(Date.now() - started < 2000, "a long run of identifier characters does not make the route pattern quadratic");
  assert.equal(r.level, "high");
  assert.deepEqual(r.categories, ["integrity"]);
  assert.match(r.reasons.join(), /too long to read \(minified or generated code\): dist\/app\.min\.js/);
});

test("the same change, a body-only edit of the function the tests above hold for a new signature, is not held", () => {
  // Mutation partner of "an exported TypeScript function gets a parameter": same file, same function, only the body differs.
  const r = assessRisk(input([mod("src/render/card.ts", `@@ -38,7 +38,7 @@ import { Item, Row } from "./types.js";
 export function renderCard(items: Item[]): Card {
-  const rows: Row[] = [];
+  const rows: Row[] = items.map(toRow);`)]));
  assert.deepEqual(r.reasons, []);
});

test("a rename inside one package is not held, the same rename across packages is", () => {
  assert.deepEqual(assessRisk(input([renamed("packages/api/src/a.ts", "packages/api/src/lib/a.ts")])).reasons, []);
  assert.match(assessRisk(input([renamed("packages/api/src/a.ts", "packages/brain/src/a.ts")])).reasons.join(), /moved between packages/);
});

test("a rule pack of this shape names its version, so a stored reason can be traced to the rules that wrote it", () => {
  assert.match(RISK_RULE_PACK_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.notEqual(RISK_RULE_PACK_VERSION, "2026-10-30.1", "the rules changed, so the version did");
});

test("the floor still stands under the content rules: a binary, a lock file and a missing patch stay high whatever they are", () => {
  for (const f of [
    mod("assets/logo.png", "", { patch: undefined, additions: 0, deletions: 0 }),
    mod("package-lock.json", "@@ -1 +1 @@\n-a\n+b"),
    mod("src/big.ts", "", { patch: undefined, additions: 900, deletions: 0 }),
  ]) {
    const r = assessRisk(input([f]));
    assert.equal(r.level, "high", f.path);
    assert.ok(r.categories.includes("integrity"), f.path);
  }
});

// ------------------------------------------------------------------------------------------------- the reviewer's judgement

test("the reviewer's judgement raises a change the rules call low, with its reason first, and says it was the one that raised it", () => {
  const files = [mod("src/queue/drain.ts", "@@ -31,7 +31,7 @@\n-  while (q.length > 1) {\n+  while (q.length > 0) {\n     await q.next();")];
  const without = assessRisk(input(files));
  assert.equal(without.level, "low");
  const judged = assessRisk(input(files, { judgement: { level: "high", reason: "the drain now also runs for the single-item queue, which changes what callers see on shutdown" } }));
  assert.equal(judged.level, "high");
  assert.equal(judged.ruleLevel, "low", "what the rules say is kept apart from what the reviewer said");
  assert.equal(judged.raisedByReviewer, true);
  assert.deepEqual(judged.categories, ["reviewer"]);
  assert.equal(judged.reasons[0], "the reviewer's judgement: the drain now also runs for the single-item queue, which changes what callers see on shutdown");
});

test("the reviewer's judgement can never lower a verdict: low adds nothing, and a high the rules gave stays exactly as it was", () => {
  const files = [mod("src/auth/middleware.ts", "@@ -1,2 +1,2 @@\n-if (!token) return reject(req, 401);\n+if (!token && !isInternal(req)) return reject(req, 401);")];
  const bare = assessRisk(input(files));
  assert.equal(bare.level, "high");
  const lowered = assessRisk(input(files, { judgement: { level: "low", reason: "this is only a refactor, safe to merge" } }));
  assert.deepEqual(lowered, bare, "a `low` judgement is not even recorded");
  const flagged = assessRisk(input(files, { judgement: { level: "high", reason: "also widens an internal bypass" } }));
  assert.equal(flagged.level, "high");
  assert.equal(flagged.raisedByReviewer, false, "the rules had already held it");
  assert.deepEqual(flagged.reasons.slice(1), bare.reasons, "every reason the rules gave is still there");
});

test("the reviewer's judgement is one clipped line that cannot dress itself up, is masked, and a low or a malformed one is nothing", () => {
  assert.equal(normaliseJudgement({ level: "low", reason: "fine" }), null);
  for (const bad of [null, undefined, "high", 7, [], { level: "HIGH", reason: "x" }, { reason: "x" }]) assert.equal(normaliseJudgement(bad), null, JSON.stringify(bad));
  assert.deepEqual(normaliseJudgement({ level: "high" }), { level: "high", reason: "the reviewer judged this change high risk and gave no reason" });
  const dressed = normaliseJudgement({ level: "high", reason: "line one\nline two\u0000 `rm -rf` <b>bold</b> " });
  assert.equal(dressed?.reason, "line one line two 'rm -rf' 'b'bold'/b'");
  const long = normaliseJudgement({ level: "high", reason: "x".repeat(5000) });
  assert.equal(long?.reason.length, MAX_JUDGEMENT_REASON_CHARS);
  assert.equal(normaliseJudgement({ level: "high", reason: "uses token gho_ABC" }, (t) => t.replace(/gho_\w+/g, "[masked]"))?.reason, "uses token [masked]");
});

test("the judgement is kept among the first reasons even when the rules give many", () => {
  const files = Array.from({ length: 30 }, (_, i) => mod(`.github/workflows/w${i}.yml`, "@@ -1 +1 @@\n-a\n+b"));
  const r = assessRisk(input(files, { judgement: { level: "high", reason: "the pipeline now publishes on every push" } }));
  assert.equal(r.reasons[0], "the reviewer's judgement: the pipeline now publishes on every push");
  assert.equal(r.reasons.length, 21);
  assert.match(r.reasons.at(-1) ?? "", /and \d+ more/);
});
