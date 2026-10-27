// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

// Service is the E2B control plane. Authorization is the caller's grant key.
type Service struct {
	grants    *grant.Service
	runner    Runner
	namespace string
}

// Options configures a Service.
type Options struct {
	Grants    *grant.Service
	Runner    Runner
	Namespace string
}

// New returns an E2B control plane.
func New(opt Options) *Service {
	return &Service{grants: opt.Grants, runner: opt.Runner, namespace: opt.Namespace}
}

// CreateBody is POST /sandboxes.
type CreateBody struct {
	TemplateID string            `json:"templateID"`
	Timeout    int64             `json:"timeout"`
	Metadata   map[string]string `json:"metadata"`
	EnvVars    map[string]string `json:"envVars"`
}

// SandboxResponse is the E2B sandbox body.
type SandboxResponse struct {
	TemplateID      string            `json:"templateID"`
	Alias           string            `json:"alias,omitempty"`
	SandboxID       string            `json:"sandboxID"`
	ClientID        string            `json:"clientID,omitempty"`
	EnvdVersion     string            `json:"envdVersion,omitempty"`
	EnvdAccessToken string            `json:"envdAccessToken,omitempty"`
	Domain          string            `json:"domain,omitempty"`
	StartedAt       string            `json:"startedAt,omitempty"`
	EndAt           string            `json:"endAt,omitempty"`
	CPUCount        int               `json:"cpuCount"`
	MemoryMB        int               `json:"memoryMB"`
	DiskSizeMB      int               `json:"diskSizeMB"`
	State           string            `json:"state,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

// ListResponse is GET /v2/sandboxes.
type ListResponse struct {
	Sandboxes []SandboxResponse `json:"sandboxes"`
	NextToken string            `json:"nextToken,omitempty"`
}

// firstWorkspace is the workspace the child workload runs in.
func firstWorkspace(names []string) (string, error) {
	if len(names) == 0 || names[0] == "" {
		return "", grant.Op(http.StatusBadRequest, "invalid_grant", "workspace is required")
	}
	return names[0], nil
}

// Create starts a sandbox, or replays an idempotency key.
// The access token is returned on this call and on connect, then only as a hash.
func (s *Service) Create(ctx context.Context, apiKey string, body CreateBody) (SandboxResponse, int, error) {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return SandboxResponse{}, 0, err
	}
	snap, err := s.grants.Snapshot(ctx, grantID)
	if err != nil {
		return SandboxResponse{}, 0, err
	}
	if err := checkMetadata(body.Metadata); err != nil {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, err
	}
	tpl, err := resolveTemplate(snap, role, body.TemplateID)
	if err != nil {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, err
	}
	if err := checkEnv(tpl.AcceptedEnvs, body.EnvVars); err != nil {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, err
	}
	workspace, err := firstWorkspace(snap.Workspaces)
	if err != nil {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, err
	}
	if snap.SessionID == "" {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, grant.Op(http.StatusBadRequest, "invalid_grant", "session is required")
	}
	timeoutSec := body.Timeout
	if timeoutSec == 0 {
		timeoutSec = defaultTimeoutSec
		if snap.MaxSandboxSeconds > 0 && timeoutSec > snap.MaxSandboxSeconds {
			timeoutSec = snap.MaxSandboxSeconds
		}
	}
	if timeoutSec < 0 {
		return SandboxResponse{}, 0, grant.Op(http.StatusBadRequest, "invalid_sandbox", "timeout must be >= 0")
	}
	if snap.MaxSandboxSeconds > 0 && timeoutSec > snap.MaxSandboxSeconds {
		s.grants.AuditDenied(ctx, grantID, "")
		return SandboxResponse{}, 0, grant.Op(http.StatusForbidden, "timeout_not_allowed", "timeout exceeds the grant cap")
	}
	sandboxID, err := newSandboxID()
	if err != nil {
		return SandboxResponse{}, 0, grant.Op(http.StatusInternalServerError, "sandbox_create_failed", "id")
	}
	token, hash, err := newAccessToken()
	if err != nil {
		return SandboxResponse{}, 0, grant.Op(http.StatusInternalServerError, "sandbox_create_failed", "token")
	}
	ref, err := s.grants.BeginSandbox(ctx, grant.BeginRequest{
		GrantID:           grantID,
		Role:              role,
		SandboxID:         sandboxID,
		Alias:             tpl.Alias,
		TemplateID:        tpl.ID,
		Namespace:         s.namespace,
		GPUs:              tpl.GPUs,
		TimeoutSec:        timeoutSec,
		PendingTimeoutSec: int64(tpl.Pending / time.Second),
		IdempotencyKey:    body.Metadata[idempotencyMetadataKey],
		AccessTokenHash:   hash,
		Metadata:          body.Metadata,
		Sealed:            tpl.Sealed,
		Inputs:            tpl.Inputs,
		Outputs:           tpl.Outputs,
	})
	var replay *grant.Replay
	if errors.As(err, &replay) {
		return s.replay(ctx, grantID, ref)
	}
	if err != nil {
		if denied(err) {
			s.grants.AuditDenied(ctx, grantID, sandboxID)
		}
		return SandboxResponse{}, 0, err
	}
	if s.runner == nil {
		_ = s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, sandboxID, "create_failed")
		return SandboxResponse{}, 0, grant.Op(http.StatusServiceUnavailable, "sandbox_unavailable", "runner is not configured")
	}
	runCtx, cancel := context.WithTimeout(ctx, tpl.Pending)
	defer cancel()
	result, runErr := s.runner.Create(runCtx, CreateRequest{
		SandboxID:   sandboxID,
		TemplateID:  tpl.ID,
		Namespace:   s.namespace,
		Timeout:     time.Duration(timeoutSec) * time.Second,
		UserID:      snap.UserID,
		UserName:    snap.UserName,
		Role:        role,
		SessionID:   snap.SessionID,
		Workspace:   workspace,
		GrantID:     snap.GrantID,
		Attestation: snap.Attestation,
		Env:         body.EnvVars,
	})
	if runErr != nil {
		_ = s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, sandboxID, "create_failed")
		if errors.Is(runErr, ErrTemplateMissing) {
			return SandboxResponse{}, 0, grant.Op(http.StatusServiceUnavailable, "template_unavailable", tpl.ID)
		}
		return SandboxResponse{}, 0, grant.Op(http.StatusInternalServerError, "sandbox_create_failed", runErr.Error())
	}
	if err := s.grants.MarkRunning(ctx, grantID, sandboxID, grant.RunningUpdate{
		SandboxName: result.SandboxName,
		Namespace:   result.Namespace,
		NodeName:    result.NodeName,
	}); err != nil {
		_ = s.runner.Delete(context.WithoutCancel(ctx), sandboxID)
		_ = s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, sandboxID, "create_failed")
		return SandboxResponse{}, 0, err
	}
	ref.State = runtimev1alpha1.SandboxRunning
	ref.SandboxName = result.SandboxName
	return createdResponse(ref, token), http.StatusCreated, nil
}

// replayPoll is how often a queued idempotency key is read again.
var replayPoll = 200 * time.Millisecond

// replay returns a finished attempt. A key that is still pending keeps waiting
// until the sandbox is running or the request ends.
func (s *Service) replay(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) (SandboxResponse, int, error) {
	ref, err := s.waitReplay(ctx, grantID, ref)
	if err != nil {
		return SandboxResponse{}, 0, err
	}
	if ref.State == runtimev1alpha1.SandboxEnded {
		return SandboxResponse{}, 0, grant.Op(http.StatusGone, "idempotency_key_spent", ref.ID)
	}
	token, err := s.addAccessToken(ctx, grantID, ref.ID)
	if err != nil {
		return SandboxResponse{}, 0, err
	}
	return createdResponse(ref, token), http.StatusOK, nil
}

// waitReplay blocks while the sandbox is still queued.
func (s *Service) waitReplay(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) (runtimev1alpha1.GrantSandboxRef, error) {
	for ref.State == runtimev1alpha1.SandboxPending {
		current, err := s.grants.Sandbox(ctx, grantID, ref.Role, ref.ID)
		if err != nil {
			return ref, err
		}
		if current.State != runtimev1alpha1.SandboxPending {
			return current, nil
		}
		select {
		case <-ctx.Done():
			return ref, grant.Op(http.StatusServiceUnavailable, "sandbox_unavailable", "sandbox is still pending")
		case <-time.After(replayPoll):
		}
	}
	return ref, nil
}

// Get returns one sandbox for this key's role. Other roles are not found.
func (s *Service) Get(ctx context.Context, apiKey, sandboxID string) (SandboxResponse, error) {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return SandboxResponse{}, err
	}
	ref, err := s.grants.Sandbox(ctx, grantID, role, sandboxID)
	if err != nil {
		return SandboxResponse{}, err
	}
	return detailResponse(ref), nil
}

// List returns sandboxes for this key's role. Ended sandboxes are omitted
// unless state is "ended".
func (s *Service) List(ctx context.Context, apiKey, metadataQuery, state, nextToken string, limit int) (ListResponse, error) {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return ListResponse{}, err
	}
	want, err := parseMetadataQuery(metadataQuery)
	if err != nil {
		return ListResponse{}, err
	}
	offset, err := decodeOffset(nextToken)
	if err != nil {
		return ListResponse{}, err
	}
	if limit <= 0 {
		limit = defaultListLimit
	}
	refs, err := s.grants.ListRoleSandboxes(ctx, grantID, role)
	if err != nil {
		return ListResponse{}, err
	}
	var filtered []runtimev1alpha1.GrantSandboxRef
	for _, ref := range refs {
		if state == "" && ref.State == runtimev1alpha1.SandboxEnded {
			continue
		}
		if state != "" && ref.State != state {
			continue
		}
		if !metadataMatch(ref.Metadata, want) {
			continue
		}
		filtered = append(filtered, ref)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].ID < filtered[j].ID })
	offset, end := pageBounds(offset, limit, len(filtered))
	page := filtered[offset:end]
	out := ListResponse{Sandboxes: make([]SandboxResponse, 0, len(page))}
	for _, ref := range page {
		out.Sandboxes = append(out.Sandboxes, detailResponse(ref))
	}
	if end < len(filtered) {
		out.NextToken = encodeOffset(end)
	}
	return out, nil
}

// Kill deletes a sandbox. A repeated delete of an ended sandbox is success.
func (s *Service) Kill(ctx context.Context, apiKey, sandboxID string) error {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return err
	}
	ref, err := s.grants.Sandbox(ctx, grantID, role, sandboxID)
	if err != nil {
		return err
	}
	if ref.State == runtimev1alpha1.SandboxEnded {
		return nil
	}
	if s.runner == nil {
		return grant.Op(http.StatusServiceUnavailable, "sandbox_unavailable", "runner is not configured")
	}
	if err := s.runner.Delete(ctx, sandboxID); err != nil {
		return grant.Op(http.StatusInternalServerError, "sandbox_delete_failed", err.Error())
	}
	return s.grants.EndSandbox(ctx, grantID, sandboxID, "killed")
}

// Connect issues another access token without invalidating recent tokens.
func (s *Service) Connect(ctx context.Context, apiKey, sandboxID string) (SandboxResponse, error) {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return SandboxResponse{}, err
	}
	ref, err := s.grants.Sandbox(ctx, grantID, role, sandboxID)
	if err != nil {
		return SandboxResponse{}, err
	}
	if ref.State == runtimev1alpha1.SandboxEnded {
		return SandboxResponse{}, grant.Op(http.StatusNotFound, "sandbox_not_found", sandboxID)
	}
	token, err := s.addAccessToken(ctx, grantID, sandboxID)
	if err != nil {
		return SandboxResponse{}, err
	}
	return createdResponse(ref, token), nil
}

func (s *Service) addAccessToken(ctx context.Context, grantID, sandboxID string) (string, error) {
	token, hash, err := newAccessToken()
	if err != nil {
		return "", grant.Op(http.StatusInternalServerError, "sandbox_create_failed", "token")
	}
	if err := s.grants.RotateToken(ctx, grantID, sandboxID, hash); err != nil {
		return "", err
	}
	return token, nil
}

// pageBounds returns a slice range that cannot overflow.
func pageBounds(offset, limit, n int) (int, int) {
	if offset > n {
		offset = n
	}
	if offset < 0 {
		offset = 0
	}
	if limit < 0 || limit > n-offset {
		return offset, n
	}
	return offset, offset + limit
}

// Timeout sets a new lifetime from now. Only the role that created the sandbox
// can change it. A value over the grant cap is refused.
func (s *Service) Timeout(ctx context.Context, apiKey, sandboxID string, timeoutSec int64) error {
	grantID, role, err := s.grants.LookupKey(ctx, apiKey)
	if err != nil {
		return err
	}
	if err := s.grants.SetSandboxTimeout(ctx, grantID, role, sandboxID, timeoutSec); err != nil {
		return err
	}
	if setter, ok := s.runner.(TimeoutRunner); ok {
		if err := setter.SetTimeout(ctx, sandboxID, time.Duration(timeoutSec)*time.Second); err != nil {
			return grant.Op(http.StatusInternalServerError, "sandbox_timeout_failed", err.Error())
		}
	}
	return nil
}

func createdResponse(ref runtimev1alpha1.GrantSandboxRef, token string) SandboxResponse {
	return SandboxResponse{
		TemplateID:      ref.TemplateID,
		Alias:           ref.Alias,
		SandboxID:       ref.ID,
		ClientID:        ref.ID,
		EnvdVersion:     envdVersion,
		EnvdAccessToken: token,
		Domain:          ref.ID,
	}
}

func detailResponse(ref runtimev1alpha1.GrantSandboxRef) SandboxResponse {
	resp := SandboxResponse{
		TemplateID:  ref.TemplateID,
		Alias:       ref.Alias,
		SandboxID:   ref.ID,
		ClientID:    ref.ID,
		EnvdVersion: envdVersion,
		State:       ref.State,
		Metadata:    ref.Metadata,
		CPUCount:    0,
		MemoryMB:    0,
		DiskSizeMB:  0,
	}
	if !ref.StartedAt.IsZero() {
		resp.StartedAt = ref.StartedAt.UTC().Format(time.RFC3339)
	}
	if !ref.EndedAt.IsZero() {
		resp.EndAt = ref.EndedAt.UTC().Format(time.RFC3339)
	}
	return resp
}

func denied(err error) bool {
	var oe *grant.OpError
	if !errors.As(err, &oe) {
		return false
	}
	return oe.Status == http.StatusForbidden || oe.Status == http.StatusTooManyRequests
}

func newSandboxID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "sbx-" + hex.EncodeToString(buf), nil
}

func newAccessToken() (string, string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	raw := "sat_" + hex.EncodeToString(buf)
	return raw, grant.HashKey(raw), nil
}

func encodeOffset(n int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(n)))
}

func decodeOffset(token string) (int, error) {
	if token == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return 0, grant.Op(http.StatusBadRequest, "invalid_next_token", "nextToken is not valid")
	}
	n, err := strconv.Atoi(string(raw))
	if err != nil || n < 0 {
		return 0, grant.Op(http.StatusBadRequest, "invalid_next_token", "nextToken is not valid")
	}
	return n, nil
}
