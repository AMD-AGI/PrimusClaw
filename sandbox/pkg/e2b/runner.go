// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package e2b serves the E2B-compatible sandbox control plane on top of a grant.
package e2b

import (
	"context"
	"errors"
	"time"
)

// ErrTemplateMissing is returned by a Runner when the CodeInterpreter does not exist.
var ErrTemplateMissing = errors.New("code interpreter template not found")

// CreateRequest is one sandbox to place in the cluster.
// SandboxID is also the session id.
type CreateRequest struct {
	SandboxID  string
	TemplateID string
	Namespace  string
	Timeout    time.Duration
	UserID     string
	UserName   string
	// Role is the grant role and the Workload display name.
	Role string
	// SessionID is the Claw session copied onto the Workload label.
	SessionID string
	// Workspace is the SaFE workspace the Workload runs in.
	Workspace string
	// GrantID is the SandboxGrant name copied onto the Workload label.
	GrantID string
	// Attestation is the Claw JWT copied onto the Workload annotation.
	Attestation string
	Env         map[string]string
	// SigningKeyPEM is the PKCS#8 Ed25519 private key written into a sealed sandbox.
	SigningKeyPEM string
	// AvoidNodes are node names the Workload must not run on, space-separated.
	AvoidNodes string
}

// CreateResult is the running sandbox address.
type CreateResult struct {
	SandboxName string
	Namespace   string
	PodIP       string
	PodPort     int
	NodeName    string
	// Cluster is the SaFE cluster id copied from the Workload, when known.
	Cluster string
}

// Runner creates and deletes sandboxes. It must not inject a platform inference key.
type Runner interface {
	Create(ctx context.Context, req CreateRequest) (CreateResult, error)
	Delete(ctx context.Context, sandboxID string) error
}

// Workload phases returned by WorkloadObserver.
const (
	WorkloadRunning  = "running"
	WorkloadPending  = "pending"
	WorkloadFinished = "finished"
	WorkloadMissing  = "missing"
)

// WorkloadObserver reads a sandbox Workload left behind by a restarted control plane.
type WorkloadObserver interface {
	Observe(ctx context.Context, sandboxID string) (CreateResult, string, error)
}

// TimeoutRunner updates the stored lifetime of a sandbox.
type TimeoutRunner interface {
	SetTimeout(ctx context.Context, sandboxID string, timeout time.Duration) error
}
