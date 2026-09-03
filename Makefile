# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# One entry point for verifying the whole repository. `make verify` is intended
# to run exactly what CI runs, so a green local run means a green pull request:
#
#   verify-claw       -> .github/workflows/tests.yml, job "claw"
#   verify-sandbox    -> .github/workflows/tests.yml, job "sandbox"
#   verify-python     -> .github/workflows/tests-coverage.yml
#   verify-docs       -> .github/workflows/docs.yml
#   verify-lint       -> .github/workflows/lint.yaml + public-tree-scan.yaml
#
# CodeQL is the one required check with no local equivalent. The image builds
# (build.yaml, agent-sandbox-build.yaml) and the dependency audits (security.yml) also have none; `make release-verify`
# covers the Docker build.
#
# Targets fail loudly when a toolchain is missing rather than skipping, because a
# verification that quietly does less than it claims is worse than no
# verification. Use `make -k verify` to run every target and see all failures
# instead of stopping at the first.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.DEFAULT_GOAL := help

# Resolved once so the error messages below can name what is missing.
NPM  := $(shell command -v npm 2>/dev/null)
GO   := $(shell command -v go 2>/dev/null)
PY   := $(shell command -v python3 2>/dev/null)

define require
	@if [ -z "$($(1))" ]; then \
		echo "error: $(2) is required for this target but was not found on PATH" >&2; \
		exit 1; \
	fi
endef

.PHONY: help
help:
	@echo "PrimusClaw — verification targets"
	@echo
	@echo "  make verify             everything below (mirrors CI)"
	@echo "  make release-verify     Docker/Helm/installer/PostgreSQL release gates"
	@echo "  make release-verify-k8s run migration smoke in the current K8s cluster"
	@echo
	@echo "  make verify-claw        Claw workspaces: build + test + hands-mcp example"
	@echo "  make verify-sandbox     Sandbox: go build + vet + test"
	@echo "  make verify-python      memory/ pytest suites"
	@echo "  make verify-docs        Sphinx build with warnings as errors"
	@echo "  make verify-lint        repo lint scripts, gofmt, public tree scan, REUSE"
	@echo
	@echo "  make demo               run Hands over MCP end to end (no cluster/GPU/LLM key)"
	@echo "  make clean              remove build output"
	@echo
	@echo "The Node version is pinned in claw/.nvmrc; Go reads sandbox/go.mod."

.PHONY: verify
verify: verify-lint verify-claw verify-sandbox verify-python verify-docs
	@echo
	@echo "verify: all targets passed"

.PHONY: release-verify
release-verify:
	@bash scripts/release-verify.sh

.PHONY: release-verify-k8s
release-verify-k8s:
	@if [ -z "$${RELEASE_IMAGE:-}" ]; then \
		echo "error: set RELEASE_IMAGE to an image available to the current cluster" >&2; \
		exit 1; \
	fi
	@command -v kubectl >/dev/null 2>&1 || { echo "error: kubectl is required" >&2; exit 1; }
	@bash scripts/release-tests/k8s-postgres-smoke.sh "$$RELEASE_IMAGE"

# --- TypeScript --------------------------------------------------------------

.PHONY: verify-claw
verify-claw:
	$(call require,NPM,npm)
	@echo "==> Claw: install"
	@cd claw && npm ci
	@echo "==> Claw: build"
	@cd claw && npm run build
	@echo "==> Claw: test"
	@cd claw && npm test
	@# CI runs the example as a smoke test on every change to Hands, so a broken
	@# example is a red check there. Running it here keeps that true locally.
	@echo "==> Claw: hands-mcp example"
	@cd claw && ./examples/hands-mcp/run.sh

# --- Go ----------------------------------------------------------------------

.PHONY: verify-sandbox
verify-sandbox:
	$(call require,GO,go)
	@echo "==> Sandbox: build + vet + test"
	@$(MAKE) -C sandbox all

# --- Python ------------------------------------------------------------------

# The e2e suites need a cluster and are excluded from CI too; this is the unit
# scope only.
.PHONY: verify-python
verify-python:
	$(call require,PY,python3)
	@echo "==> memory/: pytest"
	@# Both pytest and the packages under test are checked: with pytest present
	@# but the packages uninstalled, the run dies in collection with a wall of
	@# import errors instead of saying what to install.
	@if ! python3 -c "import pytest" >/dev/null 2>&1 \
	   || ! python3 -c "import claw_memory, knowledge_worker" >/dev/null 2>&1; then \
		echo "error: test dependencies missing. Install the same set CI uses:" >&2; \
		echo "  pip install pytest pytest-cov pytest-asyncio coverage" >&2; \
		echo "  pip install -e 'memory/memory-service/.[dev,storage]'" >&2; \
		echo "  pip install -e 'memory/knowledge-worker/.[dev]'" >&2; \
		exit 1; \
	fi
	@python3 -m pytest memory/memory-service/tests memory/knowledge-worker/tests

# --- Docs --------------------------------------------------------------------

.PHONY: verify-docs
verify-docs:
	$(call require,PY,python3)
	@echo "==> docs: sphinx -W"
	@if ! python3 -c "import sphinx" >/dev/null 2>&1; then \
		echo "error: sphinx not installed. Run: pip install -r docs/requirements.txt" >&2; \
		exit 1; \
	fi
	@python3 -m sphinx -b html -W --keep-going docs docs/_build/html
	@modules=$$(grep -ro 'id="module-' docs/_build/html/api | wc -l); \
	echo "    documented modules: $$modules"; \
	if [ "$$modules" -lt 20 ]; then \
		echo "error: API reference collapsed to $$modules modules (expected >= 20)" >&2; \
		exit 1; \
	fi

# --- Lint --------------------------------------------------------------------

.PHONY: verify-lint
verify-lint:
	@echo "==> lint: workspace hands-timeout invariant"
	@bash claw/scripts/lint-no-direct-hands-calltool-in-workspace.sh --all
	@echo "==> lint: prom-client metric registration"
	@bash claw/scripts/lint-metrics-must-register.sh --all
	@echo "==> lint: session-event redaction"
	@bash claw/scripts/lint-session-events-must-redact.sh --all
	@echo "==> lint: checkpoints are sealed, not redacted"
	@bash claw/scripts/lint-checkpoint-must-seal.sh
	@echo "==> lint: tenant-route authorization"
	@bash claw/scripts/lint-tenant-routes-must-authorize.sh --all
	@echo "==> lint: brain drain shutdown guard"
	@bash claw/scripts/lint-drain-shutdown-guard.sh --all
	@echo "==> lint: Dockerfile workspace build order"
	@bash claw/scripts/lint-dockerfile-build-order.sh --all
	@echo "==> lint: nullish env defaults"
	@bash claw/scripts/lint-no-nullish-env-default.sh --all
	@echo "==> lint: gofmt"
	@if [ -n "$(GO)" ]; then \
		$(MAKE) -C sandbox fmt-verify; \
	else \
		echo "error: go is required for gofmt verification" >&2; exit 1; \
	fi
	@# The last gate before anything reaches a public tree. It needs ripgrep with
	@# PCRE2 and exits 2 rather than reporting a clean tree it never searched.
	@echo "==> lint: public tree scan"
	@bash scripts/release-tests/public-tree-scan.sh
	@echo "==> lint: REUSE"
	@if ! command -v reuse >/dev/null 2>&1; then \
		echo "error: reuse not installed. Run: pip install reuse" >&2; \
		exit 1; \
	fi
	@reuse lint --quiet && echo "    REUSE compliant"

# --- Demo --------------------------------------------------------------------

# Exits non-zero on any failed check, so this is a smoke test as well as an
# example. Requires a Claw build; see claw/examples/hands-mcp/README.md.
.PHONY: demo
demo:
	$(call require,NPM,npm)
	@bash claw/examples/hands-mcp/run.sh

# --- Housekeeping ------------------------------------------------------------

.PHONY: clean
clean:
	@rm -rf docs/_build
	@cd claw && npm run clean 2>/dev/null || rm -rf packages/*/dist
	@if [ -n "$(GO)" ]; then $(MAKE) -C sandbox clean; fi
	@echo "clean: done"
