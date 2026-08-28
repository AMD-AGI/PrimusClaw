# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# Agent Sandbox — developer entry points.
#
# `make` runs everything that works without a cluster, a registry or GPUs:
# build, vet, unit tests. Targets that need external infrastructure (a live
# cluster, Docker, a registry) are separate and named accordingly.

.PHONY: all
all: build vet test

# ─── Image registry (override: make docker-build IMAGE_REGISTRY=your-registry.com/) ───
IMAGE_REGISTRY ?= agent-sandbox-local/
IMAGE_TAG      ?= latest

# ─── Build ─────────────────────────────────────────────────────────────────────

.PHONY: build
build:
	go build -o bin/controlplane ./cmd/controlplane
	go build -o bin/envd         ./cmd/envd

.PHONY: build-envd
build-envd:
	go build -o bin/envd ./cmd/envd

# ─── Test & static analysis ────────────────────────────────────────────────────

# Unit tests. Runs on a clean clone with no cluster and no credentials: the
# cluster-dependent suites are behind the `e2e` build tag (see test-e2e).
.PHONY: test
test:
	go test ./...

# Alias kept for callers that still say `make test-unit`.
.PHONY: test-unit
test-unit: test

.PHONY: vet
vet:
	go vet ./...

.PHONY: fmt
fmt:
	gofmt -w $(shell find . -name '*.go' -not -path './vendor/*')

.PHONY: fmt-verify
fmt-verify:
	@files=$$(gofmt -l $$(find . -name '*.go' -not -path './vendor/*')); \
	if [ -n "$$files" ]; then echo "gofmt needed on:"; echo "$$files"; exit 1; fi; \
	echo "gofmt clean"

# Uses golangci-lint when installed, otherwise falls back to `go vet` so the
# target never fails just because the linter is absent.
.PHONY: lint-go
lint-go:
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run ./...; \
	else \
		echo "golangci-lint not found; falling back to go vet"; \
		go vet ./...; \
	fi

# ─── End-to-end tests (require a live Kubernetes cluster) ─────────────────────
#
# The e2e suites are tagged `//go:build e2e` so `make test` stays runnable
# offline. They read the cluster from bin/KUBECONFIG (an explicit contract, so a
# stray default kubeconfig cannot point the tests at the wrong cluster).
.PHONY: test-e2e
test-e2e:
	@if [ ! -f bin/KUBECONFIG ]; then \
		echo "bin/KUBECONFIG not found."; \
		echo "The e2e tests run against a real cluster. Point them at one, e.g.:"; \
		echo "    mkdir -p bin && cp \$$HOME/.kube/config bin/KUBECONFIG"; \
		exit 1; \
	fi
	go test -tags e2e -count=1 -timeout 30m ./test/e2e/...

# ─── Code generation ───────────────────────────────────────────────────────────

.PHONY: gen-client
gen-client:
	@echo "Generating client-go code (requires code-generator tools)..."
	@bash hack/update-codegen.sh
	@go mod tidy

.PHONY: gen-all
gen-all: gen-client
	go generate ./...

# ─── Docker build ──────────────────────────────────────────────────────────────
#
# These are the two images the deployment actually consumes; see
# deploy/scripts/build-images.sh, which is the supported multi-arch path.

.PHONY: docker-build
docker-build: docker-build-controlplane docker-build-envd-injector

.PHONY: docker-build-controlplane
docker-build-controlplane:
	docker build -f docker/Dockerfile.controlplane -t $(IMAGE_REGISTRY)agent-sandbox-controlplane:$(IMAGE_TAG) .

.PHONY: docker-build-envd-injector
docker-build-envd-injector:
	docker build -f docker/Dockerfile.envd-injector -t $(IMAGE_REGISTRY)agent-sandbox-envd-injector:$(IMAGE_TAG) .

.PHONY: docker-build-envd-gpu
docker-build-envd-gpu: build-envd
	docker build -f docker/Dockerfile.envd-amd-gpu \
		--build-arg ENVD_BIN=bin/envd \
		-t $(IMAGE_REGISTRY)agent-sandbox-envd-amd-gpu:$(IMAGE_TAG) .

# ─── Deployment helpers ────────────────────────────────────────────────────────

.PHONY: apply-rbac
apply-rbac:
	kubectl apply -f manifests/rbac/

.PHONY: run-envd
run-envd: build-envd
	./bin/envd --port=8080 --workspace=/tmp/sandbox-workspace

.PHONY: clean
clean:
	rm -rf bin/controlplane bin/envd
