// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The setting the 2026-09-01 outage produced has to actually reach a pod.
 *
 * `NATS_REPLICAS` is the deployment-wide count every JetStream stream and every
 * KV bucket falls back to, and the rest of this set pins what the code does
 * with it -- what a blank resolves to, what a zero is replaced with, which
 * objects inherit it. Every one of those files sets the variable in its own
 * process. None of them can see the only thing that puts it in a container:
 * the chart writes `NATS_REPLICAS` into the `primus-claw-secrets` Secret from
 * `secret.natsReplicas`, and the api and brain deployments pull that whole
 * Secret in with `envFrom`. Neither deployment carries an `env:` entry for it,
 * so that chain is not one of the ways the variable arrives, it is the way.
 *
 * The outcome, not the mechanism: break a link and the setting goes inert.
 * Every pod then provisions on the code default of 3 no matter what the
 * operator wrote in their values file -- silently right on the clustered NATS
 * the chart installs, and fatal against a single-node one, where JetStream
 * answers a replicas>1 create with err 10074 and the process exits while
 * provisioning. The operator's own remedy for the outage stops being something
 * they can apply. Nothing says so: helm renders, the pods come up, and every
 * test file in this set stays green, because a chart is not code any of them
 * imports.
 *
 * Brain is not the lesser half of that. It reads `DAG_HANDLES_REPLICAS`, which
 * falls back to `NATS_REPLICAS`, on the single `js.views.kv("DAG_HANDLES", ...)`
 * call in a cluster's lifetime that can set that bucket's replica count --
 * `views.kv` ignores options on a bucket that already exists and brain
 * reconciles nothing afterwards, so a brain pod handed the wrong number bakes
 * it in for the life of the cluster (dag-handles-replicas.test.ts).
 *
 * Read with targeted line scans rather than a YAML parser: two of the three
 * chart files are Helm templates whose `{{- if }}` lines no YAML parser will
 * accept, and the question here is four keys wide.
 *
 * Coverage:
 *   C1 values.yaml declares the natsReplicas key the Secret renders from
 *   C2 the Secret maps that value onto the NATS_REPLICAS name
 *   C3 the api and brain deployments both take their environment from that Secret
 *   C4 .env.example declares the key, for the path that has no chart at all
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHART = join(REPO, "deploy", "charts", "claw");
const VALUES = join(CHART, "values.yaml");
const SECRET = join(CHART, "templates", "secret.yaml");
const API_DEPLOYMENT = join(CHART, "templates", "api-deployment.yaml");
const BRAIN_DEPLOYMENT = join(CHART, "templates", "brain-deployment.yaml");
const ENV_EXAMPLE = join(REPO, ".env.example");

/** The Secret the template creates and both deployments have to name. */
const SECRET_NAME = "primus-claw-secrets";

const read = (path: string): string[] => readFileSync(path, "utf8").split("\n");

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The lines nested under the mapping key on line `at`, by indentation.
 *
 * A list item counts as nested even though YAML lets it sit at the key's own
 * indent, which is exactly how `envFrom:` is written in both deployments -- a
 * plain "more indented" test would stop at the first `- secretRef:` and find
 * nothing.
 */
function nestedFrom(lines: string[], at: number): string[] {
  const indent = indentOf(lines[at]);
  const block: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent && !line.trimStart().startsWith("-")) break;
    block.push(line);
  }
  return block;
}

/** The same, found by the key's own line. */
function nestedUnder(lines: string[], key: RegExp, where: string): string[] {
  const at = lines.findIndex((line) => key.test(line));
  assert.notEqual(at, -1, `${where} no longer has a line matching ${key}`);
  return nestedFrom(lines, at);
}

/** Every Secret an `envFrom:` in this file hands a container wholesale. */
function envFromSecrets(lines: string[]): string[] {
  const names: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (!/^\s*envFrom:\s*$/.test(lines[at])) continue;
    const block = nestedFrom(lines, at);
    block.forEach((line, i) => {
      // `name:` under a `configMapRef:` is a different source, and a Secret
      // mounted as a volume is not an environment at all.
      const name = /^\s*name:\s*(\S+)\s*$/.exec(line);
      if (name && /secretRef:\s*$/.test(block[i - 1] ?? "")) names.push(name[1]);
    });
  }
  return names;
}

test("C1 values.yaml declares the natsReplicas key the Secret renders from", () => {
  const block = nestedUnder(read(VALUES), /^secret:/, VALUES);

  assert.ok(
    block.some((line) => /^\s*natsReplicas:/.test(line)),
    `the values file is where this setting is declared and documented. With the `
    + `key gone, .Values.secret.natsReplicas is nil, the template quotes it into `
    + `the Secret as an empty string, and the only operator who can still set a `
    + `replica count is one who reads the template to learn it exists. `
    + `Restore it in ${VALUES}.`,
  );
});

test("C2 the Secret maps that value onto the NATS_REPLICAS name", () => {
  const lines = read(SECRET);

  assert.ok(
    lines.some((line) => new RegExp(`^\\s*name:\\s*${SECRET_NAME}\\s*$`).test(line)),
    `this template has to keep creating ${SECRET_NAME}: it is the name both `
    + `deployments pull their whole environment from by`,
  );

  const entry = nestedUnder(lines, /^stringData:/, SECRET)
    .find((line) => /^\s*NATS_REPLICAS:/.test(line));

  assert.notEqual(entry, undefined,
    `this one line is the whole delivery. Without it no pod is handed `
    + `NATS_REPLICAS at all, every stream and bucket in the deployment is `
    + `provisioned at the code default of 3, and an operator's natsReplicas has `
    + `no effect on anything -- including the single-node install, where asking `
    + `for 3 is err 10074 and a process that exits while provisioning`);

  assert.match(entry ?? "", /\.Values\.secret\.natsReplicas/,
    "and it has to render from the key C1 pins, or the two halves of the chart "
    + "are each fine on their own and the operator's value still goes nowhere");
});

for (const [service, path] of [["api", API_DEPLOYMENT], ["brain", BRAIN_DEPLOYMENT]] as const) {
  test(`C3 the ${service} deployment takes its environment from that Secret`, () => {
    assert.ok(
      envFromSecrets(read(path)).includes(SECRET_NAME),
      `nothing in ${path} sets NATS_REPLICAS as an env: entry, so this envFrom `
      + `is how the ${service} container is handed it. Dropping the secretRef `
      + `leaves ${service} on the code default of 3 while the Secret next to it `
      + `says otherwise`
      + (service === "brain"
        ? ` -- and brain bakes that number into DAG_HANDLES on the one views.kv `
          + `call that can ever set it`
        : ""),
    );
  });
}

test("C4 .env.example declares NATS_REPLICAS for the path with no chart at all", () => {
  assert.ok(
    read(ENV_EXAMPLE).some((line) => /^NATS_REPLICAS=/.test(line)),
    `.env.example is the file the README says to copy and start-all.sh sources, `
    + `and the local single-node server is the one configuration that has to set `
    + `this to 1 -- a key the file never names is a key that reader never sets, `
    + `and their API exits provisioning its first stream. Restore it in ${ENV_EXAMPLE}.`,
  );
});
