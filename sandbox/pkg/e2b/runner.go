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
	Env        map[string]string
}

// CreateResult is the running sandbox address.
type CreateResult struct {
	SandboxName string
	Namespace   string
	PodIP       string
	PodPort     int
	NodeName    string
}

// Runner creates and deletes sandboxes. It must not inject a platform inference key.
type Runner interface {
	Create(ctx context.Context, req CreateRequest) (CreateResult, error)
	Delete(ctx context.Context, sandboxID string) error
}

// TimeoutRunner updates the stored lifetime of a sandbox.
type TimeoutRunner interface {
	SetTimeout(ctx context.Context, sandboxID string, timeout time.Duration) error
}
