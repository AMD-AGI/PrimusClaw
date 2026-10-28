// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

// sandboxDiskDefaultMB is the workload's 50Gi ephemeral storage, in MiB.
const sandboxDiskDefaultMB = 50 * 1024

// idempotencyHeaderPattern is the official Idempotency-Key alphabet.
var idempotencyHeaderPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// applyIdempotencyHeader copies a valid Idempotency-Key onto the metadata key.
// The metadata key remains the stored identity. A header that disagrees with
// it is rejected.
func applyIdempotencyHeader(body *CreateBody, header string) error {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil
	}
	if len(header) > 255 || !idempotencyHeaderPattern.MatchString(header) {
		return grant.Op(http.StatusBadRequest, "invalid_sandbox", "Idempotency-Key must be 1 to 255 characters of a-z, 0-9, or -")
	}
	if body.Metadata == nil {
		body.Metadata = map[string]string{}
	}
	if existing := body.Metadata[idempotencyMetadataKey]; existing != "" && existing != header {
		return grant.Op(http.StatusConflict, "idempotency_request_mismatch", "Idempotency-Key does not match the metadata key")
	}
	body.Metadata[idempotencyMetadataKey] = header
	return nil
}

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
	metadata := make(map[string]string, len(body.Metadata)+1)
	for key, value := range body.Metadata {
		metadata[key] = value
	}
	var privateKey string
	if tpl.Sealed {
		publicKey, key, keyErr := newSigningIdentity()
		if keyErr != nil {
			return SandboxResponse{}, 0, grant.Op(http.StatusInternalServerError, "sandbox_create_failed", "signing key")
		}
		metadata[signingPublicKeyMetadata] = publicKey
		privateKey = key
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
		IdempotencyKey:    metadata[idempotencyMetadataKey],
		AccessTokenHash:   hash,
		Metadata:          metadata,
		Sealed:            tpl.Sealed,
		Inputs:            tpl.Inputs,
		Outputs:           tpl.Outputs,
	})
	var replay *grant.Replay
	if errors.As(err, &replay) {
		if ref.TemplateID != tpl.ID || (body.Timeout > 0 && ref.TimeoutSec != timeoutSec) {
			return SandboxResponse{}, 0, grant.Op(http.StatusConflict, "idempotency_request_mismatch", ref.ID)
		}
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
	// Placement outlives the HTTP request. A gateway close at 180s must not
	// delete the Workload or spend the idempotency key while the pod is still pending.
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), tpl.Pending)
	defer cancel()
	result, runErr := s.runner.Create(runCtx, CreateRequest{
		SandboxID:     sandboxID,
		TemplateID:    tpl.ID,
		Namespace:     s.namespace,
		Timeout:       time.Duration(timeoutSec) * time.Second,
		UserID:        snap.UserID,
		UserName:      snap.UserName,
		Role:          role,
		SessionID:     snap.SessionID,
		Workspace:     workspace,
		GrantID:       snap.GrantID,
		Attestation:   snap.Attestation,
		Env:           body.EnvVars,
		SigningKeyPEM: privateKey,
		AvoidNodes:    excludedNodesLabel(metadata[avoidNodesMetadata]),
	})
	if runErr != nil {
		_ = s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, sandboxID, "create_failed")
		if errors.Is(runErr, ErrTemplateMissing) {
			return SandboxResponse{}, 0, grant.Op(http.StatusServiceUnavailable, "template_unavailable", tpl.ID)
		}
		return SandboxResponse{}, 0, grant.Op(http.StatusInternalServerError, "sandbox_create_failed", runErr.Error())
	}
	running := grant.RunningUpdate{
		SandboxName: result.SandboxName,
		Namespace:   result.Namespace,
		NodeName:    result.NodeName,
	}
	if result.NodeName != "" {
		running.Metadata = map[string]string{
			nodeNameMetadata: result.NodeName,
		}
		if landedOnAvoidedNode(result.NodeName, metadata[avoidNodesMetadata]) {
			running.Metadata[sameNodeMetadata] = "true"
		}
	}
	if err := s.grants.MarkRunning(context.WithoutCancel(ctx), grantID, sandboxID, running); err != nil {
		_ = s.runner.Delete(context.WithoutCancel(ctx), sandboxID)
		_ = s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, sandboxID, "create_failed")
		return SandboxResponse{}, 0, err
	}
	ref.State = runtimev1alpha1.SandboxRunning
	ref.SandboxName = result.SandboxName
	return createdResponse(ref, token), http.StatusCreated, nil
}

// replayPoll is the first wait before a queued idempotency key is read again.
// The wait doubles up to replayPollMax.
var (
	replayPoll    = 200 * time.Millisecond
	replayPollMax = 2 * time.Second
)

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
	return createdResponse(ref, token), http.StatusCreated, nil
}

// PromotePending adopts a pending sandbox whose Workload is already running or finished.
func (s *Service) PromotePending(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) error {
	_, _, err := s.adoptPending(ctx, grantID, ref)
	return err
}

// adoptPending marks a pending sandbox running, or ended when its Workload has finished.
// The second result is true when the grant record was updated.
func (s *Service) adoptPending(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) (runtimev1alpha1.GrantSandboxRef, bool, error) {
	observer, ok := s.runner.(WorkloadObserver)
	if !ok || ref.State != runtimev1alpha1.SandboxPending {
		return ref, false, nil
	}
	result, phase, err := observer.Observe(ctx, ref.ID)
	if err != nil || phase == WorkloadPending || phase == WorkloadMissing || phase == "" {
		return ref, false, err
	}
	if phase == WorkloadFinished {
		if err := s.grants.EndSandbox(context.WithoutCancel(ctx), grantID, ref.ID, "create_failed"); err != nil {
			return ref, false, err
		}
		ref.State = runtimev1alpha1.SandboxEnded
		return ref, true, nil
	}
	if phase != WorkloadRunning {
		return ref, false, nil
	}
	up := grant.RunningUpdate{SandboxName: result.SandboxName, Namespace: result.Namespace, NodeName: result.NodeName}
	if result.NodeName != "" {
		up.Metadata = map[string]string{nodeNameMetadata: result.NodeName}
		if landedOnAvoidedNode(result.NodeName, ref.Metadata[avoidNodesMetadata]) {
			up.Metadata[sameNodeMetadata] = "true"
		}
	}
	if adopter, ok := s.runner.(Adopter); ok {
		timeout := time.Duration(ref.TimeoutSec) * time.Second
		if err := adopter.Adopt(context.WithoutCancel(ctx), ref.ID, result, timeout); err != nil {
			return ref, false, err
		}
	}
	if err := s.grants.MarkRunning(context.WithoutCancel(ctx), grantID, ref.ID, up); err != nil {
		return ref, false, err
	}
	ref.State = runtimev1alpha1.SandboxRunning
	ref.SandboxName = result.SandboxName
	ref.NodeName = result.NodeName
	return ref, true, nil
}

// waitReplay blocks while the sandbox is still queued.
// A Workload that is already running is adopted, so a restarted control plane does not wait out the pending timeout.
func (s *Service) waitReplay(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) (runtimev1alpha1.GrantSandboxRef, error) {
	wait := replayPoll
	for ref.State == runtimev1alpha1.SandboxPending {
		if next, done, err := s.adoptPending(ctx, grantID, ref); err != nil || done {
			return next, err
		}
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
		case <-time.After(wait):
		}
		wait = min(2*wait, replayPollMax)
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
	if ref.State != runtimev1alpha1.SandboxRunning {
		return SandboxResponse{}, grant.Op(http.StatusNotFound, "sandbox_not_found", sandboxID)
	}
	return s.detail(ctx, grantID, ref), nil
}

// List returns running sandboxes for this key's role.
// state is empty, running, or paused. Ended sandboxes are not listed.
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
	if state != "" && state != runtimev1alpha1.SandboxRunning && state != "paused" {
		return ListResponse{}, grant.Op(http.StatusBadRequest, "invalid_sandbox", "state must be running or paused")
	}
	refs, err := s.grants.ListRoleSandboxes(ctx, grantID, role)
	if err != nil {
		return ListResponse{}, err
	}
	var filtered []runtimev1alpha1.GrantSandboxRef
	for _, ref := range refs {
		if ref.State != runtimev1alpha1.SandboxRunning || state == "paused" {
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
		out.Sandboxes = append(out.Sandboxes, s.detail(ctx, grantID, ref))
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

// detail is the SandboxDetail body. endAt is the expiry, startedAt plus the
// sandbox timeout, and state is running. cpuCount and memoryMB meet the
// schema minimum when the template does not set them.
func (s *Service) detail(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) SandboxResponse {
	spec := ""
	if snap, err := s.grants.Snapshot(ctx, grantID); err == nil {
		if tpl, _, _ := templateForExpansion(snap, ref.TemplateID); tpl.Spec != "" {
			spec = tpl.Spec
		}
	}
	cpu, mem, disk := sandboxSize(spec)
	started := ref.StartedAt.Time
	if started.IsZero() {
		started = time.Now()
	}
	started = started.UTC()
	end := started.Add(time.Duration(ref.TimeoutSec) * time.Second)
	return SandboxResponse{
		TemplateID:  ref.TemplateID,
		Alias:       ref.Alias,
		SandboxID:   ref.ID,
		ClientID:    ref.ID,
		EnvdVersion: envdVersion,
		StartedAt:   started.Format(time.RFC3339),
		EndAt:       end.Format(time.RFC3339),
		State:       runtimev1alpha1.SandboxRunning,
		Metadata:    ref.Metadata,
		CPUCount:    cpu,
		MemoryMB:    mem,
		DiskSizeMB:  disk,
	}
}

// sandboxSize reads cpu cores, memory MiB, and disk MiB from a template spec.
func sandboxSize(spec string) (int, int, int) {
	cpu, mem, disk := 1, 128, sandboxDiskDefaultMB
	if spec == "" {
		return cpu, mem, disk
	}
	var body struct {
		Resources corev1.ResourceRequirements `json:"resources"`
	}
	if err := json.Unmarshal([]byte(spec), &body); err != nil {
		return cpu, mem, disk
	}
	if q, ok := resourceQuantity(body.Resources, corev1.ResourceCPU); ok {
		cores := int((q.MilliValue() + 999) / 1000)
		if cores < 1 {
			cores = 1
		}
		cpu = cores
	}
	if q, ok := resourceQuantity(body.Resources, corev1.ResourceMemory); ok {
		mb := int((q.Value() + (1 << 20) - 1) / (1 << 20))
		if mb < 128 {
			mb = 128
		}
		mem = mb
	}
	if q, ok := resourceQuantity(body.Resources, corev1.ResourceEphemeralStorage); ok {
		disk = int((q.Value() + (1 << 20) - 1) / (1 << 20))
	}
	return cpu, mem, disk
}

func resourceQuantity(req corev1.ResourceRequirements, name corev1.ResourceName) (resource.Quantity, bool) {
	if q, ok := req.Limits[name]; ok {
		return q, true
	}
	if q, ok := req.Requests[name]; ok {
		return q, true
	}
	return resource.Quantity{}, false
}

func denied(err error) bool {
	var oe *grant.OpError
	if !errors.As(err, &oe) {
		return false
	}
	return oe.Status == http.StatusForbidden || oe.Status == http.StatusTooManyRequests
}

// newSigningIdentity returns a new Ed25519 key pair as PEM.
// The public key is PKIX. The private key is PKCS#8.
func newSigningIdentity() (publicPEM, privatePEM string, err error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return "", "", err
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return "", "", err
	}
	publicPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))
	privatePEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))
	return publicPEM, privatePEM, nil
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
