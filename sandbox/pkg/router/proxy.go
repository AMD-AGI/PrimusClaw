// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
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
		slog.Error("proxyToWM: failed to build request", "target", targetURL, "error", err)
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
		slog.Error("proxyToWM: upstream error", "target", targetURL, "error", err)
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
		slog.Error("proxy: failed to build request", "target", targetURL, "error", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to build proxy request: " + err.Error()})
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
		slog.Error("JWT: signer unavailable; refusing to proxy", "session_id", sessionID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return
	}
	token, err := s.jwt.GenerateToken(sessionID)
	if err != nil {
		slog.Error("JWT: failed to sign token; refusing to proxy", "error", err, "session_id", sessionID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return
	}
	outReq.Header.Set("Authorization", "Bearer "+token)

	// Execute upstream request
	resp, err := httpClient.Do(outReq)
	if err != nil {
		slog.Error("proxy: upstream error", "target", targetURL, "error", err)
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
		slog.Error("proxy: sandbox refused the Router's own credential",
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
