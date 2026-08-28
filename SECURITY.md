# Security Policy

## Reporting a Vulnerability

**Please do not open public issues.**

Preferred: use GitHub Private Vulnerability Reporting (Settings → Code security → Private vulnerability reporting → Enable). If enabled, submit via “Report a vulnerability” in the repo Security tab.

Alternative: use the AMD Product Security portal: https://www.amd.com/en/resources/product-security.html

When reporting, include:
- Description and impact
- Steps to reproduce or proof of concept
- Affected versions or commit hashes
- Relevant logs or environment details (if available)

We aim to acknowledge reports within 1 business day.

## Scope

This policy covers code and configuration in this repository. If the issue is in third-party dependencies, please report upstream; for AMD products unrelated to this repo, use the AMD Product Security portal.

## Supported Security Posture

PrimusClaw assumes authenticated callers can submit prompts and code, and that
code running inside a sandbox is hostile. A production deployment must:

- enable SaFE authentication with `SAFE_API_URL`; `--insecure-sandbox` and
  `ALLOW_INSECURE_NO_AUTH=true` are only for isolated development clusters;
- expose the Sandbox Router, not the Workload Manager or envd ports, to users;
- enable the Sandbox egress proxy, use an allowlist policy, and block cloud
  metadata/link-local ranges;
- use Kata (or an equivalent VM-backed runtime) when tenant code must be
  isolated from the host kernel;
- scope, rate-limit, rotate, and revoke each user's model/platform credentials;
- rebuild the images with your own CA anchors if your egress is behind a
  TLS-intercepting proxy (`--build-arg EXTRA_CA_CERT_URLS=...`), rather than
  setting `tls.insecureSkipVerify`, which disables certificate verification for
  every outbound connection the image makes;
- use the Helm-backed installers. `sandbox/deploy/k8s*` files are templates
  with unresolved placeholders, not supported standalone installations.

Tenant ownership is enforced at the Claw session boundary. `system-admin` may
read and mutate another tenant's operational resources. The
`system-admin-readonly` role may read across tenants but cannot perform
cross-tenant writes. Legacy sessions with no owner are denied to ordinary
users; only platform admins can inspect them and only a full system admin can
repair them.

## Known Limits

- Ordinary `runc` containers share the host kernel and are not a hard
  multi-tenant security boundary.
- Application-layer egress controls are not a substitute for a CNI that
  enforces Kubernetes NetworkPolicy.
- Tool event arguments are redacted before persistence using sensitive field
  names and secret patterns. This is defense in depth, not a guarantee that an
  arbitrary novel credential format cannot appear in model output. Do not put
  secrets in prompts or command arguments when a scoped secret mount is
  available.
- A user's sandbox can use credentials intentionally delegated to that user.
  Treat prompt injection as capable of spending or exfiltrating those
  credentials within their configured scope.

## Release Verification

Before publishing a release, run:

```bash
make verify
make release-verify
```

`release-verify` exercises deployment argument propagation, the installer with
mocked cluster tools, Helm lint/render, the production Docker build, the
glibc-2.31 Hands binary self-check, and PostgreSQL migrations twice. For a
cluster gate, make the built image available to the current cluster and run:

```bash
RELEASE_IMAGE=<registry>/primus-claw:<tag> make release-verify-k8s
```

That final smoke creates an isolated namespace, starts PostgreSQL, runs the
schema migration inside Kubernetes, verifies the required tables, and removes
the namespace.
