// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Caller authentication middleware for Workload Manager.
// When --enable-auth is set, the WM validates user identity on all /v1/ endpoints.
//
// In the standard deployment, Router is the unified entry point. WM still
// verifies the original credential itself: the WM Service is reachable
// inside the cluster, so identity headers alone are never authentication.
// Credentials are validated through identity provider token introspection (RFC 7662).
package workloadmanager

import (
	"errors"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	// UserIDHeader is the header carrying the verified user ID (platform camelCase convention).
	UserIDHeader = "userId"
	// UserNameHeader is the header carrying the verified user name (platform camelCase convention).
	UserNameHeader = "userName"
)

// callerAuthMiddleware verifies the caller's bearer credential on every /v1/ request.
// Caller-supplied identity and role headers are erased first and set only from a
// verified credential. A missing or inactive credential is 401; an identity
// provider that cannot answer is 503.
func (s *Server) callerAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Header.Del(UserIDHeader)
		c.Request.Header.Del(UserNameHeader)
		c.Request.Header.Del(UserRoleHeader)

		credential := identity.BearerCredential(c.GetHeader("Authorization"))
		if credential == "" {
			abortCaller(c, identity.MissingCredential)
			return
		}

		tok, err := s.cfg.Identity.Introspect(c.Request.Context(), credential)
		if err != nil {
			if errors.Is(err, identity.ErrInactive) {
				log.Warn("WM: caller credential refused", "remote_addr", c.ClientIP())
			}
			abortCaller(c, identity.RejectionFor(err))
			return
		}

		role, err := authz.ResolveRole(s.cfg.Authz, c.Request.Context(), tok)
		if err != nil {
			log.Warn("WM: caller platform role unreadable", "userId", tok.Subject, "error", err)
			abortCaller(c, authz.Unavailable)
			return
		}
		setVerifiedUser(c, tok, role)
		log.Debug("WM: auth OK", "userId", tok.Subject,
			"role", role, "path", c.Request.URL.Path)
		c.Next()
	}
}

// abortCaller answers a rejected caller.
func abortCaller(c *gin.Context, r identity.Rejection) {
	c.AbortWithStatusJSON(r.Status, gin.H{"error": r.Message, "code": r.Code})
}

// setVerifiedUser writes the verified identity to request headers and the Gin context.
func setVerifiedUser(c *gin.Context, tok identity.Token, role string) {
	c.Request.Header.Set(UserIDHeader, tok.Subject)
	c.Request.Header.Set(UserNameHeader, tok.Email)
	c.Request.Header.Set(UserRoleHeader, role)
	c.Set("userId", tok.Subject)
	c.Set("userName", tok.Email)
	c.Set("userRole", role)
}
