// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"

	"github.com/gin-gonic/gin"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// WithGrants attaches the grant execution copy used by the E2B data plane.
// The control plane still checks the API key on the Workload Manager.
func (s *Server) WithGrants(svc *grant.Service) *Server {
	s.grants = svc
	return s
}

// e2bAccessGate handles a request that carries both E2B data-plane headers.
// Other requests continue to the existing routes.
func (s *Server) e2bAccessGate(c *gin.Context) {
	sandboxID := c.GetHeader("E2b-Sandbox-Id")
	token := c.GetHeader("X-Access-Token")
	if sandboxID == "" || token == "" {
		c.Next()
		return
	}
	if s.grants == nil {
		writeGate(c, http.StatusServiceUnavailable, "sandbox_unavailable", "grant service is not configured")
		c.Abort()
		return
	}
	ref, err := s.grants.LookupAccess(c.Request.Context(), sandboxID, token)
	if err != nil {
		writeGateErr(c, err)
		c.Abort()
		return
	}
	if ref.State == runtimev1alpha1.SandboxEnded {
		writeGate(c, http.StatusBadGateway, "sandbox_ended", sandboxID)
		c.Abort()
		return
	}
	rawPath := c.Request.URL.Path
	if c.Request.URL.RawQuery != "" {
		rawPath += "?" + c.Request.URL.RawQuery
	}
	if !e2b.SealedAllows(c.Request.Method, rawPath, ref.Sealed, ref.Inputs, ref.Outputs) {
		writeGate(c, http.StatusForbidden, "sealed_denied", "path is outside the sealed allow-list")
		c.Abort()
		return
	}
	if s.store == nil {
		writeGate(c, http.StatusBadGateway, "sandbox_unavailable", "session store is not configured")
		c.Abort()
		return
	}
	info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sandboxID)
	if err != nil || info.PodIP == "" {
		writeGate(c, http.StatusBadGateway, "sandbox_unavailable", sandboxID)
		c.Abort()
		return
	}
	proxyEnvD(c, info)
	c.Abort()
}

// proxyE2B forwards an E2B control-plane call after requiring X-API-KEY.
// The Workload Manager resolves the key.
func (s *Server) proxyE2B(c *gin.Context) {
	if c.GetHeader("X-API-KEY") == "" {
		writeGate(c, http.StatusUnauthorized, "invalid_key", "X-API-KEY is required")
		return
	}
	s.proxyToWM(c)
}

func proxyEnvD(c *gin.Context, info *store.SandboxInfo) {
	port := info.PodPort
	if port == 0 {
		port = 8080
	}
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort(info.PodIP, strconv.Itoa(port))}
	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Error("envd proxy: upstream error", "podIP", info.PodIP, "port", port, "error", err)
			if gw, ok := w.(gin.ResponseWriter); ok && gw.Written() {
				return
			}
			http.Error(w, "sandbox_unavailable: envd unreachable", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

func writeGateErr(c *gin.Context, err error) {
	var oe *grant.OpError
	if errors.As(err, &oe) {
		writeGate(c, oe.Status, oe.Reason, oe.Message())
		return
	}
	writeGate(c, http.StatusInternalServerError, "internal", "internal: sandbox request failed")
}

func writeGate(c *gin.Context, status int, reason, detail string) {
	message := reason
	if detail != "" && detail != reason {
		if len(detail) >= len(reason) && detail[:len(reason)] == reason {
			message = detail
		} else {
			message = reason + ": " + detail
		}
	}
	c.JSON(status, gin.H{"code": status, "reason": reason, "message": message})
}
