// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package router — SessionManager interface for sandbox lookup/creation.
package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/net/http2"
	"k8s.io/klog/v2"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// SessionManager abstracts sandbox lookup and creation for the Router.
type SessionManager interface {
	// GetSandboxBySession returns an existing sandbox for sessionID, or creates a
	// new one (by calling WorkloadManager) when sessionID is empty.
	// When sessionID is not empty but not found in store → returns error (session expired).
	GetSandboxBySession(ctx context.Context, sessionID, namespace, name, kind string) (*store.SandboxInfo, error)
}

type callerCredentialsKey struct{}

type callerCredentials struct {
	authorization string
	cookie        string
}

func withCallerCredentials(ctx context.Context, authorization, cookie string) context.Context {
	return context.WithValue(ctx, callerCredentialsKey{}, callerCredentials{
		authorization: authorization,
		cookie:        cookie,
	})
}

func forwardCallerCredentials(ctx context.Context, req *http.Request) {
	credentials, _ := ctx.Value(callerCredentialsKey{}).(callerCredentials)
	if credentials.authorization != "" {
		req.Header.Set("Authorization", credentials.authorization)
	}
	if credentials.cookie != "" {
		req.Header.Set("Cookie", credentials.cookie)
	}
}

// defaultSessionManager is the standard implementation backed by Store + WorkloadManager HTTP API.
type defaultSessionManager struct {
	storeClient store.Store
	wmURL       string // WorkloadManager base URL
	httpClient  *http.Client
}

// NewSessionManager creates a SessionManager.
// wmURL defaults to WORKLOAD_MANAGER_URL env var if empty.
// Uses HTTP/2 transport for efficient connection reuse.
func NewSessionManager(st store.Store, wmURL string) (SessionManager, error) {
	if wmURL == "" {
		wmURL = os.Getenv("WORKLOAD_MANAGER_URL")
	}
	if wmURL == "" {
		return nil, fmt.Errorf("WORKLOAD_MANAGER_URL is not set")
	}

	// Configure HTTP/2 transport
	transport := &http.Transport{
		MaxIdleConnsPerHost: 100,
		DisableCompression:  false,
	}
	t2, err := http2.ConfigureTransports(transport)
	if err != nil {
		klog.Warningf("failed to configure HTTP/2 transport for SessionManager: %v", err)
	} else {
		t2.ReadIdleTimeout = 30 * time.Second
		t2.PingTimeout = 15 * time.Second
	}

	return &defaultSessionManager{
		storeClient: st,
		wmURL:       strings.TrimRight(wmURL, "/"),
		httpClient: &http.Client{
			Timeout:   2 * time.Minute,
			Transport: transport,
		},
	}, nil
}

// GetSandboxBySession implements SessionManager.
//   - sessionID empty  → create new sandbox via WM
//   - sessionID set    → look up store; on failure → try WM recovery from K8s
func (m *defaultSessionManager) GetSandboxBySession(
	ctx context.Context,
	sessionID, namespace, name, kind string,
) (*store.SandboxInfo, error) {
	// No session ID → create new sandbox
	if sessionID == "" {
		return m.createSandbox(ctx, namespace, name, kind)
	}

	// Session ID provided → look up in store (Redis)
	info, err := m.storeClient.GetSandboxBySessionID(ctx, sessionID)
	if err == nil {
		return info, nil
	}

	// Store lookup failed — could be:
	//   1. ErrNotFound: session key doesn't exist (expired, or Redis data lost)
	//   2. Connection error: Redis temporarily unreachable (restarting)
	//
	// In both cases, try to recover from K8s via the WM recovery endpoint.
	// The WM lists Sandbox CRs by session-id annotation, which survives Redis restarts.
	klog.Warningf("store lookup failed for session %q (err: %v), attempting K8s recovery via WM", sessionID, err)

	recovered, recoverErr := m.recoverSessionFromWM(ctx, sessionID)
	if recoverErr != nil {
		// Recovery also failed — return the original error with appropriate message.
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("session %q not found (may have expired or been deleted). "+
				"Create a new sandbox via POST /v1/code-interpreter to get a fresh sessionId.", sessionID)
		}
		return nil, fmt.Errorf("store lookup failed: %w (K8s recovery also failed: %v)", err, recoverErr)
	}

	klog.Infof("session %q recovered from K8s (sandbox: %s/%s)", sessionID, recovered.Namespace, recovered.SandboxName)
	return recovered, nil
}

// recoverSessionFromWM calls the WM session recovery endpoint to rebuild
// session→pod mapping from K8s Sandbox annotations.
// This is the fallback when Redis data is lost (e.g. Redis restart without persistence).
func (m *defaultSessionManager) recoverSessionFromWM(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	endpoint := m.wmURL + "/v1/code-interpreter/sessions/" + sessionID + "/recover"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build recovery request: %w", err)
	}
	forwardCallerCredentials(ctx, req)

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call WM recovery: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("WM recovery returned %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		SessionID   string            `json:"sessionId"`
		UserID      string            `json:"userId"`
		UserName    string            `json:"userName"`
		SandboxName string            `json:"sandboxName"`
		Namespace   string            `json:"namespace"`
		PodIP       string            `json:"podIp"`
		PodPort     int               `json:"podPort"`
		EntryPoints map[string]string `json:"entryPoints"`
		Status      string            `json:"status"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse recovery response: %w", err)
	}

	port := result.PodPort
	if port == 0 {
		port = 8080
	}

	return &store.SandboxInfo{
		SessionID:    result.SessionID,
		UserID:       result.UserID,
		UserName:     result.UserName,
		SandboxName:  result.SandboxName,
		Namespace:    result.Namespace,
		PodIP:        result.PodIP,
		PodPort:      port,
		EntryPoints:  result.EntryPoints,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		Status:       result.Status,
	}, nil
}

// createSandbox calls WorkloadManager to create a new sandbox.
func (m *defaultSessionManager) createSandbox(ctx context.Context, namespace, name, kind string) (*store.SandboxInfo, error) {
	endpoint := m.wmURL + "/v1/code-interpreter"

	reqBody, _ := json.Marshal(map[string]string{
		"name":      name,
		"namespace": namespace,
		"kind":      kind,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("build WM request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// WM independently verifies the originating caller's SaFE credential. Router
	// identity headers are deliberately not forwarded as authentication.
	forwardCallerCredentials(ctx, req)

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call WM: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s %q not found in namespace %q", kind, name, namespace)
	}
	// Also check BadRequest with "not found" message (backward compatibility)
	if resp.StatusCode == http.StatusBadRequest && strings.Contains(string(body), "not found") {
		return nil, fmt.Errorf("%s %q not found in namespace %q", kind, name, namespace)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("WM returned %d: %s", resp.StatusCode, string(body))
	}

	// Parse WM response
	var result struct {
		SessionID   string            `json:"sessionId"`
		SandboxName string            `json:"sandboxName"`
		Namespace   string            `json:"namespace"`
		EntryPoints map[string]string `json:"entryPoints"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse WM response: %w", err)
	}
	if result.SessionID == "" {
		return nil, fmt.Errorf("WM returned empty sessionId")
	}

	// Construct SandboxInfo — preserve full EntryPoints for path-based routing.
	// Also populate PodIP from EntryPoints for fallback routing.
	podIP, podPort := parseEntryPoint(result.EntryPoints)

	return &store.SandboxInfo{
		SessionID:    result.SessionID,
		SandboxName:  result.SandboxName,
		Namespace:    result.Namespace,
		PodIP:        podIP,
		PodPort:      podPort,
		EntryPoints:  result.EntryPoints,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}, nil
}

// parseEntryPoint extracts pod IP and port from WM entryPoints map.
// Used to populate PodIP/PodPort for fallback routing when EntryPoints prefix doesn't match.
func parseEntryPoint(eps map[string]string) (string, int) {
	for _, ep := range eps {
		ep = strings.TrimPrefix(ep, "http://")
		ep = strings.TrimPrefix(ep, "https://")
		host := strings.Split(ep, "/")[0]
		parts := strings.Split(host, ":")
		if len(parts) == 2 {
			port := 8080
			fmt.Sscanf(parts[1], "%d", &port)
			return parts[0], port
		}
		return host, 8080
	}
	return "", 8080
}
