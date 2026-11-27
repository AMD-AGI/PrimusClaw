## Summary

<!-- What does this PR do and why? Keep it short. -->

## Linked issues

<!-- e.g. Closes #123 / Fixes #456 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change
- [ ] CI / build / tooling
- [ ] Docs

## Affected components

<!-- Tick all that apply. -->

- [ ] Claw (api / brain / hands / protocol / utils)
- [ ] Personal agent
- [ ] Connector
- [ ] Sandbox (Go / sdk-python)
- [ ] other

## Testing

<!-- How was this verified? List commands run, environments, or manual steps. -->

## Checklist

- [ ] PR scope is focused; unrelated changes are split out
- [ ] `lint` and `build` workflows pass
- [ ] Every commit is signed off (`git commit -s`)
- [ ] I ran the checks of each tree I changed (see "Before you push" in `AGENTS.md`), not only `make verify`
- [ ] A user-visible change has a line under `[Unreleased]` in `CHANGELOG.md` (or `personal-agent/CHANGELOG.md`) that names the oldest peer version it needs
- [ ] A regression test fails when the fix is reverted
- [ ] No secrets, credentials, or internal endpoints committed (`bash scripts/release-tests/public-tree-scan.sh` is clean)
- [ ] No commit carries a `Co-authored-by` or `Signed-off-by` trailer that names an agent or a tool
- [ ] Breaking changes documented above (migration path if any)
