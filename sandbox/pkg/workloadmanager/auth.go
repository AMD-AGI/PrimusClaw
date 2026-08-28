// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// SaFE user authentication middleware for Workload Manager.
// When --enable-auth is set, the WM validates user identity on all /v1/ endpoints.
//
// In the standard deployment, Router is the unified entry point. WM still
// verifies the original SaFE credential itself: the WM Service is reachable
// inside the cluster, so identity headers alone are never authentication.
package workloadmanager

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/api"
	"sigs.k8s.io/agent-sandbox/pkg/safe"
)

const (
	// UserIDHeader is the header carrying the verified user ID (SaFE camelCase convention).
	UserIDHeader = "userId"
	// UserNameHeader is the header carrying the verified user name (SaFE camelCase convention).
	UserNameHeader = "userName"

	// maxLoggedValueLen caps a single request-derived value in a log record.
	maxLoggedValueLen = 256
)

// forLog makes a request-derived value safe to place in a log record. Client IP
// (X-Forwarded-For), user ID and request path are all caller-controlled bytes:
// a newline in one of them forges a second, fully-formed log line, and an
// unbounded one pushes real records out of a size-capped log.
func forLog(v string) string {
	if len(v) > maxLoggedValueLen {
		v = v[:maxLoggedValueLen] + "...(truncated)"
	}
	v = strings.ReplaceAll(v, "\n", "\\n")
	v = strings.ReplaceAll(v, "\r", "\\r")
	return v
}

// safeAuthMiddleware verifies a SaFE cookie or API key on every /v1/ request.
// Caller-supplied identity and role headers are overwritten only after the
// credential has been verified.
func (s *Server) safeAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Erase spoofable identity before authentication. Router forwards the
		// original SaFE credential, so WM can derive these values independently.
		c.Request.Header.Del(UserIDHeader)
		c.Request.Header.Del(UserNameHeader)
		c.Request.Header.Del(UserRoleHeader)

		if tokenCookie, err := c.Cookie("Token"); err == nil && tokenCookie != "" {
			userType, _ := c.Cookie("userType")
			user, verifyErr := s.safeClient.VerifyCookie(c.Request.Context(), tokenCookie, userType)
			if verifyErr != nil {
				slog.Warn("WM: SaFE cookie verification failed",
					"error", verifyErr,
					"remote_addr", forLog(c.ClientIP()),
				)
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "cookie verification failed: invalid or expired credential",
				})
				c.Abort()
				return
			}
			setVerifiedUser(c, user)
			c.Next()
			return
		}

		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "missing Authorization header, expected: Bearer ak-<key>",
			})
			c.Abort()
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "invalid Authorization format, expected: Bearer ak-<key>",
			})
			c.Abort()
			return
		}
		token := parts[1]

		if !safe.IsAPIKey(token) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "invalid API key format: must start with \"ak-\"",
			})
			c.Abort()
			return
		}

		user, err := s.safeClient.VerifyAPIKey(c.Request.Context(), token)
		if err != nil {
			slog.Warn("WM: SaFE API Key verification failed",
				"error", err,
				"remote_addr", forLog(c.ClientIP()),
			)
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "API key verification failed: " + err.Error(),
			})
			c.Abort()
			return
		}

		// Forward the original API Key for unified inference gateway (§4.2).
		c.Request.Header.Set(api.SandboxApiKeyHeader, token)
		setVerifiedUser(c, user)

		slog.Debug("WM: SaFE auth OK",
			"userId", forLog(user.UserID),
			"role", resolveRoleFromSaFERoles(user.Roles),
			"path", forLog(c.Request.URL.Path),
		)

		c.Next()
	}
}

func setVerifiedUser(c *gin.Context, user *safe.UserInfo) {
	role := resolveRoleFromSaFERoles(user.Roles)
	c.Request.Header.Set(UserIDHeader, user.UserID)
	c.Request.Header.Set(UserNameHeader, user.UserName)
	c.Request.Header.Set(UserRoleHeader, role)
	c.Set("userId", user.UserID)
	c.Set("userName", user.UserName)
	c.Set("userRole", role)
}
