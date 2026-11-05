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
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

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

		credential := bearerCredential(c.GetHeader("Authorization"))
		if credential == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "authentication required: use Authorization: Bearer <API key or access token>",
				"code":  "caller_credentials_missing",
			})
			return
		}

		tok, err := s.cfg.Identity.Introspect(c.Request.Context(), credential)
		if err != nil {
			if errors.Is(err, identity.ErrInactive) {
				log.Warn("WM: caller credential refused", "remote_addr", c.ClientIP())
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
					"error": "credential verification failed: invalid or expired credential",
					"code":  "caller_credential_invalid",
				})
				return
			}
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "identity provider is unavailable",
				"code":  "caller_auth_unavailable",
			})
			return
		}

		setVerifiedUser(c, tok)
		log.Debug("WM: auth OK", "userId", tok.Subject,
			"role", resolveRoleFromSaFERoles(tok.Roles), "path", c.Request.URL.Path)
		c.Next()
	}
}

// bearerCredential returns the credential of an "Authorization: Bearer" header, or "".
func bearerCredential(header string) string {
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// setVerifiedUser writes the verified identity to request headers and the Gin context.
func setVerifiedUser(c *gin.Context, tok identity.Token) {
	role := resolveRoleFromSaFERoles(tok.Roles)
	c.Request.Header.Set(UserIDHeader, tok.Subject)
	c.Request.Header.Set(UserNameHeader, tok.Email)
	c.Request.Header.Set(UserRoleHeader, role)
	c.Set("userId", tok.Subject)
	c.Set("userName", tok.Email)
	c.Set("userRole", role)
}
