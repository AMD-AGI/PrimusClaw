// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in for the GitHub REST and GraphQL API, as a `fetch`.
 *
 * It answers from plain fields a test replaces and records every request, so
 * "nothing was written" is a count of `PUT`/`POST` calls and not an inference. It
 * is as strict as the properties need: the Authorization header of every call is
 * kept, so a test can say which token went where.
 */
export const HEAD = "1".repeat(40);
export const BASE_TIP = "b".repeat(40);

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization: string;
}

export interface FakeFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export class FakeGithub {
  calls: Call[] = [];
  repo: Record<string, unknown> = {
    full_name: "AMD-AGI/demo", private: false, visibility: "public", archived: false, disabled: false, default_branch: "main",
    owner: { login: "AMD-AGI" }, permissions: { push: true, pull: true, admin: false },
    allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
  };
  pr: Record<string, any> = {
    number: 7, title: "Fix the thing", body: "Fixes the thing.", state: "open", draft: false, merged: false,
    head: { sha: HEAD, ref: "fix", repo: { full_name: "AMD-AGI/demo" } },
    base: { ref: "main", repo: { full_name: "AMD-AGI/demo" } },
    user: { login: "alice" }, author_association: "MEMBER", additions: 3, deletions: 1, changed_files: 1,
    html_url: "https://github.com/AMD-AGI/demo/pull/7",
  };
  files: FakeFile[] = [
    { filename: "src/app.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1,4 +1,6 @@\n a\n-b\n+b2\n+c\n+d\n e\n f" },
  ];
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [{ name: "test", status: "completed", conclusion: "success" }];
  statuses: Array<{ context: string; state: string }> = [];
  rules: unknown = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }];
  rulesStatus = 200;
  graphql: Record<string, any> = {
    mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED", headRefOid: HEAD,
    reviewThreads: { totalCount: 0, nodes: [] },
  };
  reviews: Array<Record<string, any>> = [];
  issueComments: Array<Record<string, any>> = [];
  reviewComments: Array<Record<string, any>> = [];
  /** path -> file text, read through the contents API. */
  contents: Record<string, string> = {};
  /** directory path -> entries. */
  dirs: Record<string, Array<{ name: string; type: string }>> = {};
  mergeStatus = 200;
  /** Runs after a review is posted, so a test can make an approval turn the merge state CLEAN. */
  onReview: (review: Record<string, any>) => void = () => {};
  /** Errors by path prefix, for a test of how failures read. */
  fail: Record<string, { status: number; message: string; method?: string }> = {};
  /** Hold every request until released, for a test of concurrency. */
  gate: Promise<void> | null = null;

  get writes(): Call[] { return this.calls.filter((c) => c.method !== "GET" && c.path !== "/graphql"); }
  count(pattern: RegExp, method?: string): number {
    return this.calls.filter((c) => pattern.test(c.path) && (!method || c.method === method)).length;
  }

  fetch = async (input: URL | string | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    const call: Call = {
      method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.Authorization ?? "",
    };
    this.calls.push(call);
    if (this.gate) await this.gate;
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-github-request-id": `REQ-${this.calls.length}`, ...extra } });
    for (const [prefix, f] of Object.entries(this.fail)) {
      if (call.path.startsWith(prefix) && (!f.method || f.method === method)) return json(f.status, { message: f.message });
    }
    const p = call.path;
    if (p === "/graphql") return json(200, { data: { repository: { pullRequest: this.graphql } } });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return json(200, this.repo);
    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(p)) return json(200, this.pr);
    if (/\/pulls\/\d+\/files$/.test(p)) {
      const per = Number(call.query.per_page ?? 30);
      const page = Number(call.query.page ?? 1);
      return json(200, this.files.slice((page - 1) * per, page * per));
    }
    if (/\/commits\/[0-9a-f]{40}\/check-runs$/.test(p)) return json(200, { total_count: this.checkRuns.length, check_runs: this.checkRuns });
    if (/\/commits\/[0-9a-f]{40}\/status$/.test(p)) return json(200, { total_count: this.statuses.length, state: "success", statuses: this.statuses });
    if (/\/rules\/branches\//.test(p)) return this.rulesStatus === 200 ? json(200, this.rules) : json(this.rulesStatus, { message: "nope" });
    if (/\/issues\/\d+\/comments$/.test(p)) return json(200, this.issueComments);
    if (/\/pulls\/\d+\/comments$/.test(p)) return json(200, this.reviewComments);
    if (/\/pulls\/\d+\/reviews$/.test(p)) {
      if (method === "GET") return json(200, this.reviews);
      const review = { id: 900 + this.reviews.length, state: call.body.event === "APPROVE" ? "APPROVED" : "COMMENTED", user: { login: "bob" }, commit_id: call.body.commit_id, body: call.body.body, html_url: "https://github.com/AMD-AGI/demo/pull/7#pullrequestreview-1", event: call.body.event };
      this.reviews.push(review);
      this.onReview(review);
      return json(200, review);
    }
    if (/\/pulls\/\d+\/merge$/.test(p) && method === "PUT") {
      if (this.mergeStatus !== 200) return json(this.mergeStatus, { message: this.mergeStatus === 409 ? "Head branch was modified" : "Not mergeable" });
      return json(200, { sha: "m".repeat(40), merged: true, message: "Pull Request successfully merged" });
    }
    if (/\/git\/ref\/heads\/(.+)$/.test(p)) return json(200, { object: { sha: BASE_TIP } });
    const contents = /\/contents\/(.+)$/.exec(p);
    if (contents) {
      const path = decodeURIComponent(contents[1] as string);
      // Contents are read at the base tip or the base branch, never at the head.
      this.contentRefs.push(call.query.ref ?? "");
      if (this.dirs[path]) return json(200, this.dirs[path]);
      if (path in this.contents) {
        const text = this.contents[path] as string;
        return json(200, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length });
      }
      return json(404, { message: "Not Found" });
    }
    return json(404, { message: `unhandled ${method} ${p}` });
  };

  contentRefs: string[] = [];
}
