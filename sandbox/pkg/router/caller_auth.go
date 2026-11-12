// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Caller authentication middleware for the Router (default on; --enable-auth=false to disable).
// A caller presents "Authorization: Bearer <credential>": a platform API key (ak-...) or an
// access token issued by the identity provider for this service. The credential is
// validated through identity provider token introspection (RFC 7662).
package router

import (
	"errors"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
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

// setUserContext sets userId, userName, and userRole in both Gin context and request headers.
func setUserContext(c *gin.Context, tok identity.Token, role string) {
	c.Request.Header.Set(UserIDHeader, tok.Subject)
	if tok.Email != "" {
		c.Request.Header.Set(UserNameHeader, tok.Email)
	}
	c.Set("userId", tok.Subject)
	c.Set("userName", tok.Email)

	c.Set("userRole", role)
	c.Request.Header.Set(UserRoleHeader, role)
}

// bearerCredential returns the credential of the request's "Authorization: Bearer" header, or "".
func bearerCredential(c *gin.Context) string {
	return identity.BearerCredential(c.GetHeader("Authorization"))
}

// abortCaller records the rejection and answers it.
func abortCaller(c *gin.Context, r identity.Rejection) {
	recordCallerAuthRejection(c, r.Status)
	c.AbortWithStatusJSON(r.Status, gin.H{"error": r.Message, "code": r.Code})
}

// callerAuthMiddleware verifies the caller's bearer credential through identity introspection.
// A missing or inactive credential is 401; an identity provider that cannot answer is 503.
func (s *Server) callerAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, forwarded := invokeHopFrom(c); forwarded {
			c.Next()
			return
		}
		credential := bearerCredential(c)
		if credential == "" {
			abortCaller(c, identity.MissingCredential)
			return
		}

		tok, err := s.cfg.Identity.Introspect(c.Request.Context(), credential)
		if err != nil {
			if errors.Is(err, identity.ErrInactive) {
				log.Warn("caller credential refused", "remote_addr", c.ClientIP())
			}
			abortCaller(c, identity.RejectionFor(err))
			return
		}

		role, err := authz.ResolveRole(s.cfg.Authz, c.Request.Context(), tok)
		if err != nil {
			log.Warn("caller platform role unreadable", "userId", tok.Subject, "error", err)
			abortCaller(c, authz.Unavailable)
			return
		}
		setUserContext(c, tok, role)
		log.Debug("auth OK", "userId", tok.Subject,
			"role", role, "path", c.Request.URL.Path)
		c.Next()
	}
}
