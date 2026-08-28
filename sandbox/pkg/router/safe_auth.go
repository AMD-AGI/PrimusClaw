// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// SaFE user authentication middleware for the Router.
// This is the "Layer 1" user identity authentication (default off, --enable-auth to enable).
//
// Supports two authentication paths:
//  1. SaFE cookie (browser): reads Token cookie → validates against SaFE apiserver → cached 5min
//  2. API Key (SDK/CLI): reads "Authorization: Bearer ak-xxx" → validates against SaFE apiserver → cached 5min
package router

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/api"
	"sigs.k8s.io/agent-sandbox/pkg/safe"
)

const (
	// UserIDHeader is the header carrying the verified user ID.
	// Uses SaFE convention (camelCase): SaFE gateway injects "userId" after cookie validation,
	// and our auth middleware uses the same name for API Key path — zero conversion needed.
	UserIDHeader = "userId"
	// UserNameHeader is the header carrying the user's display name (SaFE convention).
	UserNameHeader = "userName"
	// UserRoleHeader carries the resolved user role (system-admin / system-admin-readonly / default).
	// Set by Router auth middleware → forwarded to WM via proxy.
	UserRoleHeader = "userRole"
)

// stripUntrustedIdentityHeaders removes identity asserted by the network
// caller. The authentication middleware repopulates these headers from the
// verified SaFE response before proxying to Workload Manager.
func stripUntrustedIdentityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Header.Del(UserIDHeader)
		c.Request.Header.Del(UserNameHeader)
		c.Request.Header.Del(UserRoleHeader)
		c.Next()
	}
}

// resolveRoleFromSaFERoles picks the highest-priority role from SaFE roles array.
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
func setUserContext(c *gin.Context, user *safe.UserInfo) {
	c.Request.Header.Set(UserIDHeader, user.UserID)
	if user.UserName != "" {
		c.Request.Header.Set(UserNameHeader, user.UserName)
	}
	c.Set("userId", user.UserID)
	c.Set("userName", user.UserName)

	// Resolve role from SaFE roles array and inject into context + header
	role := resolveRoleFromSaFERoles(user.Roles)
	c.Set("userRole", role)
	c.Request.Header.Set(UserRoleHeader, role)
}

// safeAuthMiddleware returns a Gin middleware that supports two authentication paths:
//
//  1. SaFE cookie (browser): reads Token cookie → validates against SaFE /api/v1/users/self → cached.
//  2. API Key (SDK/CLI): reads "Authorization: Bearer ak-xxx" → validates against SaFE → cached.
func (s *Server) safeAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// ── Path 1: SaFE cookie authentication (browser) ──
		// Browser carries Token cookie set by SaFE login. Validate against SaFE apiserver.
		// NOTE: Cookie auth does NOT set api.SandboxApiKeyHeader — browser users have no
		// API Key, so the unified inference gateway (§4.2) is not available for
		// sandboxes created via Cookie auth. Use SDK/CLI (API Key) to create
		// sandboxes that need LLM inference.
		if tokenCookie, err := c.Cookie("Token"); err == nil && tokenCookie != "" {
			userType, _ := c.Cookie("userType")
			user, verifyErr := s.safeClient.VerifyCookie(c.Request.Context(), tokenCookie, userType)
			if verifyErr != nil {
				slog.Warn("SaFE cookie verification failed",
					"error", verifyErr, "remote_addr", c.ClientIP())
				recordCallerAuthRejection(c, http.StatusUnauthorized)
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "cookie verification failed: invalid or expired credential",
					"code":  "caller_cookie_invalid",
				})
				c.Abort()
				return
			}
			setUserContext(c, user)
			slog.Debug("auth OK (cookie)", "userId", user.UserID,
				"role", resolveRoleFromSaFERoles(user.Roles), "path", c.Request.URL.Path)
			c.Next()
			return
		}

		// ── Path 2: API Key authentication (SDK/CLI) ──
		authHeader := c.GetHeader("Authorization")
		if authHeader != "" {
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && safe.IsAPIKey(parts[1]) {
				apiKey := parts[1]
				user, err := s.safeClient.VerifyAPIKey(c.Request.Context(), apiKey)
				if err != nil {
					slog.Warn("SaFE API Key verification failed",
						"error", err, "remote_addr", c.ClientIP())
					recordCallerAuthRejection(c, http.StatusUnauthorized)
					c.JSON(http.StatusUnauthorized, gin.H{
						"error": "API key verification failed: invalid or expired credential",
						"code":  "caller_api_key_invalid",
					})
					c.Abort()
					return
				}
				setUserContext(c, user)
				// Forward the original API Key for unified inference gateway (§4.2).
				// WM stores this in Redis; EnvD pulls it and injects as OPENAI_API_KEY.
				c.Request.Header.Set(api.SandboxApiKeyHeader, apiKey)
				slog.Debug("auth OK (API Key)", "userId", user.UserID,
					"role", resolveRoleFromSaFERoles(user.Roles), "path", c.Request.URL.Path)
				c.Next()
				return
			}
		}

		// ── No valid credentials ──
		recordCallerAuthRejection(c, http.StatusUnauthorized)
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "authentication required: use SaFE login (browser) or API Key (Authorization: Bearer ak-<key>)",
			"code":  "caller_credentials_missing",
		})
		c.Abort()
	}
}
