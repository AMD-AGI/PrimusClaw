// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"crypto/rsa"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	// EnvUpstreamOnly makes a cluster Router accept /v1 calls only as invocations
	// forwarded by the managing Router.
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
			recordCallerAuthRejection(c, http.StatusUnauthorized)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "this Router accepts /v1 calls only from the managing Router",
				"code":  "upstream_hop_required",
			})
			return
		}
		c.Next()
	}
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
// that cluster's Router. A session in the local store stays local. It reports false
// when the session is not a remote Workload, and true when the request has been answered.
func (s *Server) forwardRemoteInvocation(c *gin.Context, sessionID string) bool {
	if s.locator == nil || len(s.dp.routes) == 0 {
		return false
	}
	if _, forwarded := invokeHopFrom(c); forwarded {
		return false
	}
	if s.store != nil {
		if _, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID); err == nil {
			return false
		}
	}
	cluster, namespace, ownerID, err := s.locator(c.Request.Context(), sessionID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Warn("invoke: workload lookup failed", "sessionId", sessionID, "error", err)
		}
		return false
	}
	base, ok := s.forwardTarget(cluster)
	if !ok {
		return false
	}
	if s.cfg.EnableAuth && !handsPassthroughFrom(c) && !s.authorizeSessionOwner(c, ownerID) {
		return true
	}
	if s.jwt == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return true
	}
	token, err := s.jwt.generateInvokeToken(sessionID, cluster, namespace,
		c.GetString("userId"), c.GetString("userName"), c.GetString("userRole"))
	if err != nil {
		log.Error("invoke: failed to sign forward token", "error", err, "sessionId", sessionID, "cluster", cluster)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sandbox authentication unavailable"})
		return true
	}
	target, err := url.Parse(base)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "cluster route is invalid"})
		return true
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
	return true
}

// verifyInvokeToken checks the managing Router's signature, audience, and cluster
// of a forwarded invocation token.
func verifyInvokeToken(pub *rsa.PublicKey, raw, cluster string) (invokeHop, error) {
	if pub == nil || raw == "" {
		return invokeHop{}, errors.New("missing invoke token")
	}
	token, err := jwt.Parse(raw, func(token *jwt.Token) (interface{}, error) {
		return pub, nil
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(jwtIssuer),
		jwt.WithAudience(invokeAudience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(time.Minute),
	)
	if err != nil || !token.Valid {
		return invokeHop{}, errors.New("invalid invoke token")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
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
