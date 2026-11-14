// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	// EnvUpstreamOnly makes a cluster Router accept /v1 calls only as invocations
	// forwarded by the managing Router and refuse the E2B control plane. It is off
	// unless set to true.
	EnvUpstreamOnly = "SANDBOX_UPSTREAM_ONLY"

	invocationRoute = "/v1/namespaces/:namespace/code-interpreters/:name/invocations/*path"
	ctxInvokeHop    = "invokeHop"
)

// WorkloadLocator reports the cluster, namespace, and owner of a SaFE Workload by name.
// A name that is not a live Workload is store.ErrNotFound.
type WorkloadLocator func(ctx context.Context, name string) (cluster, namespace, ownerID string, err error)

// invokeHop is a verified invocation forwarded by the managing Router.
type invokeHop struct {
	SessionID string
	Namespace string
	UserID    string
	UserName  string
	Role      string
}

// WithWorkloadLocator lets the Router forward invocations of Workloads in other clusters.
func (s *Server) WithWorkloadLocator(locate WorkloadLocator) *Server {
	s.locator = locate
	return s
}

// ConfigureUpstreamOnly applies the EnvUpstreamOnly value. Empty is off. A true
// value turns the mode on and requires the cluster id and upstream key; a value
// that is not a boolean is an error.
func (s *Server) ConfigureUpstreamOnly(raw string) error {
	on := false
	if v := strings.TrimSpace(raw); v != "" {
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("%s=%q is not a boolean", EnvUpstreamOnly, raw)
		}
		on = parsed
	}
	if err := s.SetUpstreamOnly(on); err != nil {
		return err
	}
	log.Info("dataplane upstream-only resolved", "upstream_only", on, "upstream_key", s.dp.upstream != nil, "cluster_id", s.dp.clusterID)
	return nil
}

// SetUpstreamOnly turns on the mode in which /v1 accepts only forwarded invocations.
// It requires a configured cluster id and upstream public key.
func (s *Server) SetUpstreamOnly(on bool) error {
	if on && (s.dp.upstream == nil || s.dp.clusterID == "") {
		return errors.New(EnvUpstreamOnly + " requires " + EnvClusterID + " and " + EnvUpstreamPublicKey)
	}
	s.dp.upstreamOnly = on
	return nil
}

// invokeHopMiddleware accepts an invocation forwarded by the managing Router and
// sets the caller identity the token carries. In upstream-only mode every other
// /v1 request except /v1/health is 401.
func (s *Server) invokeHopMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.dp.upstream == nil || s.dp.clusterID == "" {
			c.Next()
			return
		}
		if c.FullPath() == invocationRoute {
			if hop, err := verifyInvokeToken(s.dp.upstream, bearerCredential(c), s.dp.clusterID); err == nil {
				setHopUserContext(c, hop)
				c.Next()
				return
			}
		}
		if s.dp.upstreamOnly && c.FullPath() != "/v1/health" {
			s.rejectDirectCaller(c)
			return
		}
		c.Next()
	}
}

// rejectDirectCaller answers a caller that did not arrive as a forwarded invocation.
func (s *Server) rejectDirectCaller(c *gin.Context) {
	recordCallerAuthRejection(c, http.StatusUnauthorized)
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"error": "this Router accepts calls only from the managing Router",
		"code":  "upstream_hop_required",
	})
}

// setHopUserContext records a verified forwarded invocation and its caller identity.
func setHopUserContext(c *gin.Context, hop invokeHop) {
	c.Request.Header.Set(UserIDHeader, hop.UserID)
	c.Request.Header.Set(UserNameHeader, hop.UserName)
	c.Request.Header.Set(UserRoleHeader, hop.Role)
	c.Set("userId", hop.UserID)
	c.Set("userName", hop.UserName)
	c.Set("userRole", hop.Role)
	c.Set(ctxInvokeHop, hop)
}

// invokeHopFrom returns the verified forwarded invocation of this request, if any.
func invokeHopFrom(c *gin.Context) (invokeHop, bool) {
	v, ok := c.Get(ctxInvokeHop)
	if !ok {
		return invokeHop{}, false
	}
	hop, ok := v.(invokeHop)
	return hop, ok
}

// forwardRemoteInvocation sends an invocation of a Workload in another cluster to
// that cluster's Router. A session in the local store stays local and is returned
// so the caller does not look it up again. handled is true when the request has
// been answered. Namespace admission for a remote Workload is applied by the
// cluster Router that serves its namespace; this Router's selector covers only
// namespaces in its own cluster.
func (s *Server) forwardRemoteInvocation(c *gin.Context, sessionID string) (handled bool, local *store.SandboxInfo) {
	if s.locator == nil || len(s.dp.routes) == 0 {
		return false, nil
	}
	if _, forwarded := invokeHopFrom(c); forwarded {
		return false, nil
	}
	if s.store != nil {
		if info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID); err == nil {
			return false, info
		}
	}
	cluster, namespace, ownerID, err := s.locator(c.Request.Context(), sessionID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Warn("invoke: workload lookup failed", "sessionId", sessionID, "error", err)
		}
		return false, nil
	}
	base, ok := s.forwardTarget(cluster)
	if !ok {
		return false, nil
	}
	if s.cfg.EnableAuth && !s.authorizeSessionOwner(c, ownerID) {
		return true, nil
	}
	if s.jwt == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return true, nil
	}
	token, err := s.jwt.generateInvokeToken(sessionID, cluster, namespace,
		c.GetString("userId"), c.GetString("userName"), c.GetString("userRole"))
	if err != nil {
		log.Error("invoke: failed to sign forward token", "error", err, "sessionId", sessionID, "cluster", cluster)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return true, nil
	}
	s.proxyToCluster(c, base, cluster, token)
	return true, nil
}

// proxyToCluster forwards the original request to a cluster Router, replacing
// the caller credential with an invoke token.
func (s *Server) proxyToCluster(c *gin.Context, base, cluster, token string) {
	target, err := url.Parse(base)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "cluster route is invalid"})
		return
	}
	target.Path = strings.TrimRight(target.Path, "/") + c.Request.URL.Path
	target.RawPath = ""
	target.RawQuery = c.Request.URL.RawQuery
	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Director: func(req *http.Request) {
			req.URL = target
			req.Host = target.Host
			req.Header.Del("Cookie")
			req.Header.Del(UserIDHeader)
			req.Header.Del(UserNameHeader)
			req.Header.Del(UserRoleHeader)
			req.Header.Del(identity.APIKeyHeader)
			req.Header.Set("Authorization", "Bearer "+token)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Error("invoke: cluster router unreachable", "cluster", cluster, "error", err)
			if gw, ok := w.(gin.ResponseWriter); ok && gw.Written() {
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"cluster router unreachable","code":"sandbox_unavailable"}`))
		},
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

// verifyInvokeToken checks the managing Router's signature, audience, and cluster
// of a forwarded invocation token.
func verifyInvokeToken(pub *rsa.PublicKey, raw, cluster string) (invokeHop, error) {
	if pub == nil || raw == "" {
		return invokeHop{}, errors.New("missing invoke token")
	}
	claims, err := parseRouterToken(pub, raw, invokeAudience)
	if err != nil {
		return invokeHop{}, errors.New("invalid invoke token")
	}
	str := func(key string) string {
		v, _ := claims[key].(string)
		return v
	}
	if str("session_id") == "" || str("cluster") != cluster {
		return invokeHop{}, errors.New("invoke token does not match this cluster")
	}
	return invokeHop{
		SessionID: str("session_id"),
		Namespace: str("namespace"),
		UserID:    str("sub"),
		UserName:  str("user_name"),
		Role:      str("role"),
	}, nil
}
