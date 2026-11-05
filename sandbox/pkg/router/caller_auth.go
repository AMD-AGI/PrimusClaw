// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Caller authentication middleware for the Router (default on; --enable-auth=false to disable).
// A caller presents "Authorization: Bearer <credential>": a platform API key (ak-...) or an
// access token issued by the identity provider for this service. The credential is
// validated through identity provider token introspection (RFC 7662).
package router

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	// UserIDHeader is the header carrying the verified user ID.
	// Uses the platform convention (camelCase) that Workload Manager reads.
	UserIDHeader = "userId"
	// UserNameHeader is the header carrying the user's display name.
	UserNameHeader = "userName"
	// UserRoleHeader carries the resolved user role (system-admin / system-admin-readonly / default).
	// Set by Router auth middleware → forwarded to WM via proxy.
	UserRoleHeader = "userRole"
)

// stripUntrustedIdentityHeaders removes identity asserted by the network
// caller. The authentication middleware repopulates these headers from the
// verified identity before proxying to Workload Manager.
func stripUntrustedIdentityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Header.Del(UserIDHeader)
		c.Request.Header.Del(UserNameHeader)
		c.Request.Header.Del(UserRoleHeader)
		c.Next()
	}
}

// resolveRoleFromSaFERoles picks the highest-priority role from a platform roles array.
// Priority: system-admin > system-admin-readonly > default.
func resolveRoleFromSaFERoles(roles []string) string {
	best := "default"
	for _, r := range roles {
		switch r {
		case "system-admin":
			return "system-admin"
		case "system-admin-readonly":
			best = "system-admin-readonly"
		}
	}
	return best
}

// setUserContext sets userId, userName, and userRole in both Gin context and request headers.
func setUserContext(c *gin.Context, tok identity.Token) {
	c.Request.Header.Set(UserIDHeader, tok.Subject)
	if tok.Email != "" {
		c.Request.Header.Set(UserNameHeader, tok.Email)
	}
	c.Set("userId", tok.Subject)
	c.Set("userName", tok.Email)

	role := resolveRoleFromSaFERoles(tok.Roles)
	c.Set("userRole", role)
	c.Request.Header.Set(UserRoleHeader, role)
}

// bearerCredential returns the credential of an "Authorization: Bearer" header, or "".
func bearerCredential(c *gin.Context) string {
	parts := strings.SplitN(c.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// callerAuthMiddleware verifies the caller's bearer credential through identity introspection.
// A missing or inactive credential is 401; an identity provider that cannot answer is 503.
func (s *Server) callerAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, forwarded := invokeHopFrom(c); forwarded {
			c.Next()
			return
		}
		if isHandsPassthrough(c) {
			c.Set(ctxHandsPassthrough, true)
			c.Next()
			return
		}
		credential := bearerCredential(c)
		if credential == "" {
			recordCallerAuthRejection(c, http.StatusUnauthorized)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "authentication required: use Authorization: Bearer <API key or access token>",
				"code":  "caller_credentials_missing",
			})
			return
		}

		tok, err := s.cfg.Identity.Introspect(c.Request.Context(), credential)
		if err != nil {
			if errors.Is(err, identity.ErrInactive) {
				log.Warn("caller credential refused", "remote_addr", c.ClientIP())
				recordCallerAuthRejection(c, http.StatusUnauthorized)
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
					"error": "credential verification failed: invalid or expired credential",
					"code":  "caller_credential_invalid",
				})
				return
			}
			recordCallerAuthRejection(c, http.StatusServiceUnavailable)
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "identity provider is unavailable",
				"code":  "caller_auth_unavailable",
			})
			return
		}

		setUserContext(c, tok)
		log.Debug("auth OK", "userId", tok.Subject,
			"role", resolveRoleFromSaFERoles(tok.Roles), "path", c.Request.URL.Path)
		c.Next()
	}
}
