// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"
	"fmt"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// WithE2B serves the E2B control plane on this Workload Manager.
func (s *Server) WithE2B(svc *e2b.Service) *Server {
	if svc == nil || s.router == nil {
		return s
	}
	e2b.NewHandler(svc).Mount(s.router)
	return s
}

// Create places a grant sandbox. The platform inference key is not stored:
// a grant sandbox must not receive OPENAI_API_KEY from this path.
func (s *Server) Create(ctx context.Context, req e2b.CreateRequest) (e2b.CreateResult, error) {
	if req.SandboxID == "" || req.Namespace == "" || req.TemplateID == "" {
		return e2b.CreateResult{}, fmt.Errorf("sandbox id, template, and namespace are required")
	}
	now := time.Now()
	ttl := s.cfg.DefaultTTL
	if req.Timeout > 0 {
		ttl = req.Timeout
	}
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	placeholder := &store.SandboxInfo{
		SessionID:    req.SandboxID,
		SandboxName:  req.TemplateID + "-pending",
		Namespace:    req.Namespace,
		PodPort:      8080,
		CreatedAt:    now,
		LastActivity: now,
		ExpiresAt:    now.Add(ttl),
		Status:       "creating",
		UserID:       req.UserID,
		UserName:     req.UserName,
	}
	if err := s.store.StoreSandbox(ctx, placeholder); err != nil {
		return e2b.CreateResult{}, err
	}

	podIP := "127.0.0.1"
	sandboxName := req.TemplateID
	sandboxKind := store.SandboxKind
	namespace := req.Namespace
	port := 8080
	nodeName := ""
	var policy *SandboxResult
	switch {
	case s.workloads != nil:
		result, err := s.workloads.Create(ctx, req)
		if err != nil {
			_ = s.store.DeleteSandboxBySessionID(context.WithoutCancel(ctx), req.SandboxID)
			if errors.Is(err, ErrTemplateNotFound) {
				return e2b.CreateResult{}, e2b.ErrTemplateMissing
			}
			return e2b.CreateResult{}, err
		}
		podIP = result.PodIP
		sandboxName = result.SandboxName
		sandboxKind = result.Kind
		if result.Namespace != "" {
			namespace = result.Namespace
		}
		if result.PodPort > 0 {
			port = result.PodPort
		}
		if result.MaxSessionDuration > 0 {
			ttl = result.MaxSessionDuration
		}
		nodeName = result.NodeName
		policy = result
	case s.k8s != nil:
		_ = s.store.DeleteSandboxBySessionID(context.WithoutCancel(ctx), req.SandboxID)
		return e2b.CreateResult{}, fmt.Errorf("safe workload client is not configured")
	}

	info := &store.SandboxInfo{
		Kind:         sandboxKind,
		SessionID:    req.SandboxID,
		SandboxName:  sandboxName,
		Namespace:    namespace,
		PodIP:        podIP,
		PodPort:      port,
		CreatedAt:    now,
		LastActivity: now,
		ExpiresAt:    now.Add(ttl),
		Status:       "running",
		UserID:       req.UserID,
		UserName:     req.UserName,
		EntryPoints:  map[string]string{"/": fmt.Sprintf("%s:%d", podIP, port)},
	}
	if policy != nil {
		info.RuntimePolicy = policy.RuntimePolicy
		info.PolicyMode = "enforce"
		info.AllowedEgressHosts = policy.AllowedEgressHosts
		info.AllowedInternalHosts = policy.AllowedInternalHosts
		info.PolicyVersion = 1
	}
	if err := s.store.UpdateSandbox(ctx, info); err != nil {
		_ = s.deleteSandboxAndSession(context.WithoutCancel(ctx), info, "e2b-create-failed")
		return e2b.CreateResult{}, err
	}
	return e2b.CreateResult{
		SandboxName: sandboxName,
		Namespace:   namespace,
		PodIP:       podIP,
		PodPort:     port,
		NodeName:    nodeName,
	}, nil
}

// Observe reads a sandbox Workload without creating one.
func (s *Server) Observe(ctx context.Context, sandboxID string) (e2b.CreateResult, string, error) {
	if s == nil || s.workloads == nil {
		return e2b.CreateResult{}, e2b.WorkloadPending, nil
	}
	return s.workloads.Observe(ctx, sandboxID)
}

// Delete removes the sandbox session charged to a grant.
func (s *Server) Delete(ctx context.Context, sandboxID string) error {
	return s.ReclaimSession(ctx, sandboxID)
}

// SetTimeout moves the session expiry to now plus timeout.
// The caller only reaches this after the grant accepts the new duration.
// A SaFE Workload stores that same lifetime as a duration from its start time.
func (s *Server) SetTimeout(ctx context.Context, sandboxID string, timeout time.Duration) error {
	info, err := s.store.GetSandboxBySessionID(ctx, sandboxID)
	if err != nil {
		return err
	}
	if timeout <= 0 {
		return fmt.Errorf("timeout must be > 0")
	}
	now := time.Now()
	if info.Kind == store.WorkloadKind {
		if s.workloads == nil {
			return fmt.Errorf("safe workload client is not configured")
		}
		if err := s.workloads.AlignTimeout(ctx, info.SandboxName, timeout, now); err != nil {
			return err
		}
	}
	info.ExpiresAt = now.Add(timeout)
	return s.store.UpdateSandbox(ctx, info)
}
