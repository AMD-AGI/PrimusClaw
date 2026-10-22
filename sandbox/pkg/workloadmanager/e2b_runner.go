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
	port := 8080
	var policy *SandboxResult
	if s.k8s != nil {
		var overrides *SandboxOverrides
		if len(req.Env) > 0 || req.Timeout > 0 {
			overrides = &SandboxOverrides{Environment: req.Env}
			if req.Timeout > 0 {
				overrides.MaxSessionDuration = req.Timeout.String()
			}
		}
		var user *UserIdentity
		if req.UserID != "" {
			user = &UserIdentity{UserID: req.UserID, UserName: req.UserName}
		}
		result, err := s.k8s.CreateSandbox(ctx, req.SandboxID, req.TemplateID, req.Namespace, user, overrides)
		if err != nil {
			_ = s.store.DeleteSandboxBySessionID(ctx, req.SandboxID)
			if errors.Is(err, ErrTemplateNotFound) {
				return e2b.CreateResult{}, e2b.ErrTemplateMissing
			}
			return e2b.CreateResult{}, err
		}
		podIP = result.PodIP
		sandboxName = result.SandboxName
		sandboxKind = result.Kind
		if result.PodPort > 0 {
			port = result.PodPort
		}
		if result.MaxSessionDuration > 0 {
			ttl = result.MaxSessionDuration
		}
		policy = result
	}

	info := &store.SandboxInfo{
		Kind:         sandboxKind,
		SessionID:    req.SandboxID,
		SandboxName:  sandboxName,
		Namespace:    req.Namespace,
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
		s.deleteSandboxAndSession(ctx, info, "e2b-create-failed")
		return e2b.CreateResult{}, err
	}
	return e2b.CreateResult{
		SandboxName: sandboxName,
		Namespace:   req.Namespace,
		PodIP:       podIP,
		PodPort:     port,
	}, nil
}

// Delete removes the sandbox session charged to a grant.
func (s *Server) Delete(ctx context.Context, sandboxID string) error {
	return s.ReclaimSession(ctx, sandboxID)
}

// SetTimeout moves the session expiry to now plus timeout.
func (s *Server) SetTimeout(ctx context.Context, sandboxID string, timeout time.Duration) error {
	info, err := s.store.GetSandboxBySessionID(ctx, sandboxID)
	if err != nil {
		return err
	}
	if timeout <= 0 {
		return fmt.Errorf("timeout must be > 0")
	}
	info.ExpiresAt = time.Now().Add(timeout)
	return s.store.UpdateSandbox(ctx, info)
}
