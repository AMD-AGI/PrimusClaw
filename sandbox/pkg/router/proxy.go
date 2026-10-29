// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

var httpClient = &http.Client{
	Timeout: 10 * time.Minute, // Allow long-running commands
	Transport: &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	},
}

// proxyToWM reverse-proxies the request to the Workload Manager service.
// This enables a unified API gateway: Router is the single entry point,
// control-plane requests are transparently forwarded to WM.
func (s *Server) proxyToWM(c *gin.Context) {
	wmURL := s.cfg.WorkloadManagerURL
	if wmURL == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "workload manager URL not configured"})
		return
	}

	// Build target URL: WM base URL + original request path (+ query string)
	targetURL := strings.TrimRight(wmURL, "/") + c.Request.URL.Path
	if c.Request.URL.RawQuery != "" {
		targetURL += "?" + c.Request.URL.RawQuery
	}

	r := c.Request
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		log.Error("proxyToWM: failed to build request", "target", targetURL, "error", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to build proxy request"})
		return
	}

	// Copy request headers (skip hop-by-hop)
	for key, vals := range r.Header {
		switch key {
		case "Connection", "Upgrade", "Transfer-Encoding", "Keep-Alive", "Proxy-Authorization", "Te", "Trailers":
			// skip
		default:
			for _, v := range vals {
				outReq.Header.Add(key, v)
			}
		}
	}

	resp, err := httpClient.Do(outReq)
	if err != nil {
		log.Error("proxyToWM: upstream error", "target", targetURL, "error", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "workload manager unreachable: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	w := c.Writer
	for key, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	// Stream response body
	if flusher, ok := w.(http.Flusher); ok {
		buf := make([]byte, 4096)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				_, _ = w.Write(buf[:n])
				flusher.Flush()
			}
			if readErr != nil {
				break
			}
		}
	} else {
		_, _ = io.Copy(w, resp.Body)
	}
}

// proxyRequest forwards the request to the target URL and streams the response back.
func (s *Server) proxyRequest(c *gin.Context, targetURL string, sessionID string) {
	r := c.Request

	// Build outbound request
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		log.Error("proxy: failed to build request", "target", targetURL, "error", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to build proxy request: " + err.Error()})
		return
	}

	// The destination is not caller-chosen, and this check is what keeps it that
	// way observable at the point it matters. targetURL is assembled by
	// determineUpstreamURL from the PodIP / EntryPoints recorded for the session
	// -- server-side state written by Workload Manager from the Pod status, never
	// from anything in the request. The only caller-controlled parts, the request
	// path and query, are appended *after* the authority, where they cannot move
	// the request to another host: "http://10.0.0.1:8080/@evil.com/x" still dials
	// 10.0.0.1. So a caller cannot steer this proxy at an arbitrary host, and a
	// static analyser flagging the caller-tainted path as SSRF is reading the
	// concatenation, not the URL grammar.
	//
	// The guard stays because this handler mints a Router-signed JWT a few lines
	// below and hands it to whatever address the session record names. A record
	// with an empty PodIP and no matching EntryPoint produces "http://:8080/...",
	// which Go dials as the *local* host on 8080 -- the Router's own port -- and
	// that is reachable today from a sandbox whose Pod has lost its IP. Sending a
	// valid sandbox credential there is not a leak to an attacker, but it is a
	// credential going somewhere nobody intended, and 8080 is exactly the port
	// port_proxy refuses to expose for the same reason. Fail closed instead of
	// discovering it in an EnvD audit log.
	if (outReq.URL.Scheme != "http" && outReq.URL.Scheme != "https") || outReq.URL.Hostname() == "" {
		log.Error("proxy: refusing to proxy to an upstream with no resolvable host",
			"target", targetURL, "session_id", sessionID,
			"hint", "the session record has no PodIP and no matching EntryPoint; the sandbox Pod is probably not Running")
		c.JSON(http.StatusBadGateway, gin.H{"error": "sandbox upstream address is not available"})
		return
	}

	// Copy request headers (skip hop-by-hop)
	for key, vals := range r.Header {
		switch key {
		case "Connection", "Upgrade", "Transfer-Encoding", "Keep-Alive", "Proxy-Authorization", "Te", "Trailers":
			// skip
		default:
			for _, v := range vals {
				outReq.Header.Add(key, v)
			}
		}
	}

	// Inject session-id header for EnvD context
	outReq.Header.Set("x-session-id", sessionID)

	// EnvD accepts only Router-signed requests. Never fall back to an
	// unauthenticated upstream request when key setup or signing fails.
	//
	// Neither branch is a degraded serving mode, and reading them as one is the
	// trap: there is no path where the Router keeps answering execs without a
	// verifiable key. A nil signer cannot be reached at all today, because
	// router.New refuses to build a Server whose identity did not reconcile and
	// main exits on that error. Signing failure is reachable but only for a key
	// that stopped validating after startup.
	//
	// Both stay because the invariant they enforce -- never proxy unsigned --
	// belongs here rather than in whatever the startup path happens to do this
	// month. If that path is ever changed to keep serving, these turn a silent
	// 401 storm from the sandbox into an explicit 503 from the Router.
	if s.jwt == nil {
		log.Error("JWT: signer unavailable; refusing to proxy", "session_id", sessionID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return
	}
	policy, err := s.sessionPolicy(c, sessionID)
	if err != nil {
		log.Error("proxy: failed to read sealed policy", "error", err, "session_id", sessionID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return
	}
	token, err := s.jwt.GenerateScopedToken(sessionID, policy)
	if err != nil {
		log.Error("JWT: failed to sign token; refusing to proxy", "error", err, "session_id", sessionID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return
	}
	outReq.Header.Del(e2b.HeaderSealed)
	outReq.Header.Del(e2b.HeaderInputs)
	outReq.Header.Del(e2b.HeaderOutputs)
	outReq.Header.Set("Authorization", "Bearer "+token)

	// Execute upstream request
	resp, err := httpClient.Do(outReq)
	if err != nil {
		log.Error("proxy: upstream error", "target", targetURL, "error", err)
		if strings.Contains(err.Error(), "connection refused") {
			c.JSON(http.StatusBadGateway, gin.H{"error": "sandbox unreachable"})
		} else if strings.Contains(err.Error(), "timeout") {
			c.JSON(http.StatusGatewayTimeout, gin.H{"error": "sandbox timeout"})
		} else {
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error: " + err.Error()})
		}
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	w := c.Writer
	for key, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}

	// A 401/403 from EnvD is about the Router's credential, not the caller's:
	// Authorization was overwritten above with a Router-signed JWT, so nothing
	// the caller sent reached the sandbox. Passing the status through unlabelled
	// makes it indistinguishable from the SaFE rejection the middleware returns,
	// which is how a signing-key mismatch reads as "the user's key expired".
	// Label the stage and count it; the status itself is left alone so client
	// behaviour does not change.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		w.Header().Set(authStageHeader, authStageEnvD)
		sandboxAuthRejections.WithLabelValues(authStageEnvD, strconv.Itoa(resp.StatusCode)).Inc()
		log.Error("proxy: sandbox refused the Router's own credential",
			"status", resp.StatusCode,
			"session_id", sessionID,
			"target", targetURL,
			"hint", "Router and EnvD disagree on the JWT key, or the session-id binding does not match; check the envd-router-identity Secret and whether Workload Manager has been restarted since it was rotated")
	}

	// Always set session-id in response
	w.WriteHeader(resp.StatusCode)

	// Stream response body (supports SSE)
	if flusher, ok := w.(http.Flusher); ok {
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				_, _ = w.Write(buf[:n])
				flusher.Flush()
			}
			if err != nil {
				break
			}
		}
	} else {
		_, _ = io.Copy(w, resp.Body)
	}
}

// errGrantRecordMissing reports a grant sandbox id that no grant records.
var errGrantRecordMissing = errors.New("sandbox grant record is missing")

// grantPolicyTTL bounds how long a grant sandbox policy is reused.
// The policy is fixed when the sandbox is created.
const grantPolicyTTL = time.Minute

// grantPolicyCacheLimit bounds the policy cache before expired entries are dropped.
const grantPolicyCacheLimit = 4096

type cachedPolicy struct {
	policy  e2b.RequestPolicy
	expires time.Time
}

// sessionPolicy returns the sealed allow-list recorded for a grant sandbox.
// Other sessions stay unsealed. A grant sandbox without a grant record is
// errGrantRecordMissing, and a grant lookup failure is returned as is.
func (s *Server) sessionPolicy(c *gin.Context, sessionID string) (e2b.RequestPolicy, error) {
	if !strings.HasPrefix(sessionID, "sbx-") {
		return e2b.RequestPolicy{}, nil
	}
	if s.grants == nil {
		return e2b.RequestPolicy{}, errGrantRecordMissing
	}
	now := time.Now()
	if policy, ok := s.cachedPolicy(sessionID, now); ok {
		return policy, nil
	}
	ref, ok, err := s.grants.SandboxByID(c.Request.Context(), sessionID)
	if err != nil {
		return e2b.RequestPolicy{}, err
	}
	if !ok {
		return e2b.RequestPolicy{}, errGrantRecordMissing
	}
	policy := e2b.RequestPolicy{Sealed: ref.Sealed, Inputs: ref.Inputs, Outputs: ref.Outputs}
	s.storePolicy(sessionID, policy, now)
	return policy, nil
}

// cachedPolicy returns a policy that has not expired.
func (s *Server) cachedPolicy(sessionID string, now time.Time) (e2b.RequestPolicy, bool) {
	s.policyMu.Lock()
	defer s.policyMu.Unlock()
	entry, ok := s.policies[sessionID]
	if !ok || !now.Before(entry.expires) {
		return e2b.RequestPolicy{}, false
	}
	return entry.policy, true
}

// storePolicy caches a policy and drops expired entries once the cache is full.
func (s *Server) storePolicy(sessionID string, policy e2b.RequestPolicy, now time.Time) {
	s.policyMu.Lock()
	defer s.policyMu.Unlock()
	if s.policies == nil {
		s.policies = map[string]cachedPolicy{}
	}
	if len(s.policies) >= grantPolicyCacheLimit {
		for id, entry := range s.policies {
			if !now.Before(entry.expires) {
				delete(s.policies, id)
			}
		}
	}
	if len(s.policies) >= grantPolicyCacheLimit {
		return
	}
	s.policies[sessionID] = cachedPolicy{policy: policy, expires: now.Add(grantPolicyTTL)}
}
