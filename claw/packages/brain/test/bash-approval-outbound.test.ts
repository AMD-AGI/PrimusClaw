// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outbound-actions rule pack (examples/bash-approval/outbound-actions.json),
 * run through the real rule compiler. A command matrix: for every rule, commands
 * it must hold and commands next to it that must run, each also wrapped in
 * sudo / env / bash -c / a leading `cd ... &&`. A held command is asserted to
 * come back with THAT rule's label, not just "some rule held it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bashApprovalFromEnvValue, bashApprovalPolicyFrom, MALFORMED_LABEL,
} from "../src/agent/bash-approval.js";

const PACK = readFileSync(new URL("../../../examples/bash-approval/outbound-actions.json", import.meta.url), "utf8");
const policy = () => bashApprovalPolicyFrom([{ source: "outbound-actions.json", value: bashApprovalFromEnvValue(PACK) }]);

const L = {
  force: "git push --force / --delete (rewrites or deletes remote history)",
  push: "git push (publishes commits to a remote)",
  pr: "gh pr write (creates, changes or merges a pull request)",
  release: "gh release write (publishes or changes a release)",
  apiWrite: "gh api write (POST / PUT / PATCH / DELETE)",
  apiFields: "gh api with fields or a body (an implied POST)",
  repo: "gh repo write (creates, changes or deletes a repository)",
  workflow: "gh workflow write (runs, enables or disables a workflow)",
  kubectl: "kubectl write (changes cluster state or runs a command in a pod)",
  helm: "helm write (installs, upgrades or removes a release)",
  rm: "recursive rm outside /workspace (or of /workspace itself)",
} as const;

interface Row {
  label: string;
  /** Commands this rule must hold. */
  held: string[];
  /** Commands that must run: nothing in the pack may hold them. */
  allowed: string[];
  /** Near misses another rule of the pack holds instead: [command, that rule's label]. */
  elsewhere?: Array<[string, string]>;
}

const MATRIX: Row[] = [
  { label: L.force,
    held: [
      "git push --force origin main",
      "git push -f origin main",
      "git push origin main --force-with-lease",
      "git push --force-with-lease=main:abc123 origin main",
      "git push origin --delete old-branch",
      "git push -d origin old-branch",
      "git push origin :old-branch",
      "git push origin +main",
      "git push -fu origin feat/x",
      "git push --mirror backup",
      "git -C /workspace/repo push --force",
      "git --git-dir=/workspace/repo/.git push -f",
    ],
    allowed: [
      "git fetch --force origin",
      "git checkout -f main",
      "git branch -d old-branch",
      "git stash push -m wip",
      "git clean -fd",
    ],
    elsewhere: [
      ["git push origin main", L.push],
      ["git push -u origin feat/x", L.push],
      ["git push origin fix-f", L.push],
      ["git push origin HEAD:refs/heads/x", L.push],
    ] },
  { label: L.push,
    held: [
      "git push",
      "git push origin main",
      "git push -u origin feat/session-repo-binding",
      "git push origin HEAD:refs/heads/feat/x",
      "git push --tags",
      "git -C /workspace/app push",
      "git -C /workspace/app -c credential.helper= push origin main",
      "git --git-dir=/workspace/app/.git --work-tree=/workspace/app push origin main",
      "git -c user.name=bot push",
      "/usr/bin/git push",
      "git push 2>&1",
      "cd /workspace/app && git add -A && git commit -m x && git push -u origin HEAD",
      "git status; git push",
      "git push origin main 2>&1 | tee /tmp/push.log",
      "git push --dry-run",
      "ssh devbox git push origin main",
      "kubectl exec -it pod-x -- git push origin main",
      "bash -c 'cd /workspace/app && git push'",
    ],
    allowed: [
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git fetch origin",
      "git pull --ff-only",
      "git clone https://github.com/example-org/example-repo.git",
      "git checkout -b feat/push-fix",
      "git branch -vv",
      "git commit -m \"document how to push\"",
      "git commit -m push",
      "git stash",
      "git stash push -m wip",
      "git log --grep=push",
      "git remote -v",
      "git -C /workspace/app status",
      "git -C /workspace/app log -3",
      "git add -A",
      "git config alias.p push",
      "echo \"git push origin main\"",
    ] },
  { label: L.pr,
    held: [
      "gh pr create --title x --body y",
      "gh pr create --fill",
      "gh pr merge 12 --squash",
      "gh pr merge --auto 12",
      "gh pr close 12",
      "gh pr review 12 --approve",
      "gh pr ready 12",
      "gh pr edit 12 --add-label bug",
      "gh pr -R example-org/example-repo merge 12",
      "gh pr comment 12 --body done",
      "gh pr reopen 12",
      "gh pr update-branch 12",
      "GH_REPO=example-org/example-repo gh pr create --fill",
      "gh -R example-org/example-repo pr create --fill",
      "gh --repo example-org/example-repo pr merge 12 --squash",
      "gh -R example-org/example-repo pr -R example-org/example-repo close 12",
    ],
    allowed: [
      "gh pr view 12",
      "gh pr view 12 --json title,state",
      "gh pr list --state open",
      "gh pr list -R example-org/example-repo",
      "gh pr checks 12",
      "gh pr diff 12",
      "gh pr status",
      "gh pr checkout 12",
      "gh -R example-org/example-repo pr view 12",
      "gh --repo example-org/example-repo pr list",
    ] },
  { label: L.release,
    held: [
      "gh release create v1.0.0 --notes x",
      "gh release create v1.0.0 ./dist/a.tgz",
      "gh release upload v1.0.0 a.tgz",
      "gh release delete v1.0.0 -y",
      "gh release edit v1.0.0 --draft=false",
      "gh release -R example-org/example-repo create v2",
    ],
    allowed: [
      "gh release list",
      "gh release view v1.0.0",
      "gh release download v1.0.0 -p '*.tgz'",
    ] },
  { label: L.apiWrite,
    held: [
      "gh api -X POST repos/example-org/example-repo/issues",
      "gh api --method PUT repos/example-org/example-repo/topics",
      "gh api -X PATCH repos/example-org/example-repo -f description=x",
      "gh api repos/example-org/example-repo/git/refs/heads/x -X DELETE",
      "gh api -XDELETE repos/example-org/example-repo/git/refs/heads/x",
      "gh api --method=post repos/example-org/example-repo/issues",
      "gh -R example-org/example-repo api -X POST repos/example-org/example-repo/issues",
      "gh api -H 'Accept: application/vnd.github+json' --method DELETE repos/example-org/example-repo/hooks/1",
    ],
    allowed: [
      "gh api repos/example-org/example-repo",
      "gh api user",
      "gh api -X GET repos/example-org/example-repo/pulls",
      "gh api --method GET search/issues -f q=is:open",
      "gh api repos/example-org/example-repo/pulls --paginate --jq '.[].number'",
      "gh api -H 'Accept: application/vnd.github+json' repos/example-org/example-repo/branches",
    ] },
  { label: L.apiFields,
    held: [
      "gh api repos/example-org/example-repo/issues -f title=x",
      "gh api repos/example-org/example-repo/issues -F body=@note.md",
      "gh api graphql -f query='{ viewer { login } }'",
      "gh api repos/example-org/example-repo/issues --input body.json",
      "gh api --field title=x repos/example-org/example-repo/issues",
      "gh api --raw-field a=b repos/example-org/example-repo/issues",
      "gh api -f title=x repos/example-org/example-repo/issues",
      "gh -R example-org/example-repo api -f title=x repos/example-org/example-repo/issues",
      "gh api -F n=1 repos/example-org/example-repo/issues",
      "gh api --input - repos/example-org/example-repo/issues",
    ],
    allowed: [
      "gh api repos/example-org/example-repo/pulls",
      "gh api -X GET search/code -f q=term",
      "gh api -XGET search/code -F per_page=5",
      "gh api --method=GET search/issues -f q=is:open",
      "gh api repos/example-org/example-repo --jq .name",
    ] },
  { label: L.repo,
    held: [
      "gh repo create example-org/new-repo --private",
      "gh repo delete example-org/old-repo --yes",
      "gh repo edit example-org/example-repo --visibility public",
      "gh repo fork example-org/example-repo --clone",
      "gh repo rename new-name",
      "gh repo sync",
    ],
    allowed: [
      "gh repo view example-org/example-repo",
      "gh repo view --json name",
      "gh repo clone example-org/example-repo",
      "gh repo list example-org",
    ] },
  { label: L.workflow,
    held: [
      "gh workflow run ci.yml",
      "gh workflow run ci.yml --ref main -f key=value",
      "gh workflow disable ci.yml",
      "gh workflow enable ci.yml",
      "gh workflow -R example-org/example-repo run ci.yml",
    ],
    allowed: [
      "gh workflow list",
      "gh workflow view ci.yml",
      "gh run list",
      "gh run view 123 --log",
    ] },
  { label: L.kubectl,
    held: [
      "kubectl apply -f x.yaml",
      "kubectl apply -k overlays/prod",
      "kubectl delete pod foo",
      "kubectl -n prod delete deploy x",
      "kubectl --namespace=prod scale deploy/x --replicas=0",
      "kubectl patch deploy x -p '{\"spec\":{\"replicas\":1}}'",
      "kubectl rollout restart deploy/x",
      "kubectl rollout undo deploy/x",
      "kubectl exec -it pod-x -- sh",
      "kubectl exec pod-x -- ls /",
      "kubectl --context prod --kubeconfig /tmp/kc apply -f y.yaml",
      "kubectl create namespace x",
      "kubectl drain node-1 --ignore-daemonsets",
    ],
    allowed: [
      "kubectl get pods -A",
      "kubectl describe pod x",
      "kubectl logs -f pod/x",
      "kubectl -n kube-system get deploy",
      "kubectl -n apply get pods",
      "kubectl rollout status deploy/x",
      "kubectl rollout history deploy/x",
      "kubectl config current-context",
      "kubectl top nodes",
    ] },
  { label: L.helm,
    held: [
      "helm install x ./chart",
      "helm upgrade --install x ./chart -n ns",
      "helm -n ns uninstall x",
      "helm rollback x 2",
      "helm --kube-context prod upgrade x y",
      "helm push chart.tgz oci://registry.example.invalid/charts",
    ],
    allowed: [
      "helm list -A",
      "helm template x ./chart",
      "helm status x",
      "helm get values x",
      "helm lint ./chart",
      "helm -n install list",
      "helm repo add example https://charts.example.invalid",
    ] },
  { label: L.rm,
    held: [
      "rm -rf /tmp/build",
      "rm -rf /",
      "rm -fr /var/lib/x",
      "rm -r /etc/foo",
      "rm -Rf /home/user/x",
      "rm --recursive --force /opt/x",
      "rm -rf ~/work",
      "rm -rf $HOME/x",
      "rm -rf \"${HOME}/x\"",
      "rm -rf /workspace/../etc",
      "rm -rf /workspace/a/../../etc",
      "rm -rf /workspace2/x",
      "rm -rf /workspace/ok /tmp/bad",
      "rm /tmp/x -rf",
      "rm -rf /workspace",
      "rm -rf /workspace/",
      "rm -rf /workspace/*",
      "rm -rf ../../etc",
      "rm -rf ../sibling",
      "rm -rf ..",
      "rm -r a/../../b",
      "rm -rf ./build ../x",
      "cd /workspace/app && rm -rf ../../..",
    ],
    allowed: [
      "rm file.txt",
      "rm -f /tmp/x.log",
      "rm -rf node_modules",
      "rm -rf build dist",
      "rm -r ./tmp",
      "rm -rf /workspace/app/build",
      "rm -rf /workspace/a /workspace/b",
      "rm /etc/hosts.bak",
      "rm -rf ./build",
      "rm -rf build/..cache ..hidden",
      "rm -rf node_modules/.bin",
    ] },
];

const shq = (c: string) => `'${c.replace(/'/g, `'\\''`)}'`;
/** The same command behind each wrapper the matcher must look through. */
const wrapped = (c: string) => [
  `sudo ${c}`, `sudo -u root ${c}`, `env X=1 ${c}`, `env -u HOME ${c}`, `bash -c ${shq(c)}`, `sh -c "${c.replace(/(["\\$`])/g, "\\$1")}"`,
  `cd /workspace/app && ${c}`, `timeout 30 ${c}`, `nohup ${c}`,
];

test("the pack is a well-formed rule list: it holds the matrix commands and nothing else by accident", () => {
  const p = policy();
  assert.equal(p.active, true);
  // A malformed pack holds every command; a harmless one must run.
  assert.equal(p.check("ls -la"), null);
  assert.notEqual(p.check("ls -la"), MALFORMED_LABEL);
  assert.equal(JSON.parse(PACK).length, Object.keys(L).length);
});

test("every rule in the pack has a matrix row with at least 3 held and 3 allowed commands", () => {
  const labels = (JSON.parse(PACK) as Array<{ label: string }>).map((r) => r.label);
  assert.deepEqual(new Set(labels), new Set(Object.values(L)), "pack labels and test labels are the same closed set");
  assert.equal(new Set(labels).size, labels.length, "labels are unique, so a label identifies one rule");
  for (const label of labels) {
    const rows = MATRIX.filter((r) => r.label === label);
    assert.equal(rows.length, 1, `exactly one matrix row for: ${label}`);
    assert.ok(rows[0].held.length >= 3, `held >= 3 for: ${label}`);
    assert.ok(rows[0].allowed.length >= 3, `allowed >= 3 for: ${label}`);
  }
});

for (const row of MATRIX) {
  test(`holds, with this label: ${row.label}`, () => {
    const p = policy();
    for (const c of row.held) assert.equal(p.check(c), row.label, c);
  });

  test(`holds through sudo / env / bash -c / cd && / timeout: ${row.label}`, () => {
    const p = policy();
    for (const c of row.held) {
      for (const w of wrapped(c)) assert.equal(p.check(w), row.label, w);
    }
  });

  test(`runs the neighbours, also wrapped: ${row.label}`, () => {
    const p = policy();
    for (const c of row.allowed) {
      assert.equal(p.check(c), null, c);
      for (const w of wrapped(c)) assert.equal(p.check(w), null, w);
    }
    for (const [c, other] of row.elsewhere ?? []) assert.equal(p.check(c), other, c);
  });
}

test("a command line is held when any one command in it is held, and the first rule names it", () => {
  const p = policy();
  assert.equal(p.check("git status && git push origin main"), L.push);
  // Rules are tried in pack order, and each is tried against every command of the line: force comes first.
  assert.equal(p.check("git push origin main && git push --force"), L.force);
  assert.equal(p.check("npm test && git log -1 && git diff --stat"), null);
  assert.equal(p.check("echo done | tee out.txt; gh pr view 1"), null);
});

test("text that only mentions an outbound command does not hold", () => {
  const p = policy();
  for (const c of [
    "echo git push origin main",
    "echo 'gh pr create --fill'",
    "grep -rn 'kubectl delete' docs/",
    "git commit -m 'gh pr merge and git push are held'",
    "cat > notes.md <<< 'helm install x'",
    "git log --grep='gh api -X POST'",
  ]) assert.equal(p.check(c), null, c);
});

test("a long adversarial command is matched in linear time, not backtracked forever", () => {
  const p = policy();
  const cases = [
    `git ${"-c ".repeat(30000)}status`,
    `git ${"-C x ".repeat(15000)}status`,
    `kubectl ${"-n x ".repeat(15000)}get pods`,
    `helm ${"--namespace x ".repeat(5000)}list`,
    `gh pr ${"-R x ".repeat(15000)}view 1`,
    `gh api ${"-f a=b ".repeat(12000)}-X GET x`,
    `rm -rf ${"a ".repeat(40000)}`,
    `rm -rf ${"a/".repeat(40000)}`,
    `gh ${"-R x ".repeat(15000)}pr view 1`,
  ];
  for (const c of cases) {
    const t0 = Date.now();
    const r = p.check(c);
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `${c.slice(0, 30)}... took ${ms} ms`);
    assert.equal(r, null, c.slice(0, 30));
  }
});

test("a long command that IS held is held in linear time too", () => {
  const p = policy();
  for (const [c, label] of [
    [`rm -rf ${"../".repeat(30000)}x`, L.rm],
    [`rm -rf ${"a ".repeat(20000)}/tmp/x`, L.rm],
    [`git ${"-C x ".repeat(12000)}push origin main`, L.push],
    [`gh ${"-R x ".repeat(12000)}pr create`, L.pr],
  ] as Array<[string, string]>) {
    const t0 = Date.now();
    assert.equal(p.check(c), label, c.slice(0, 30));
    assert.ok(Date.now() - t0 < 1500, `${c.slice(0, 30)}... took ${Date.now() - t0} ms`);
  }
});
