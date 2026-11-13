// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"errors"
	"net/http"
	"strings"
)

const (
	// RoleSystemAdmin may act on every user's sandboxes.
	RoleSystemAdmin = "system-admin"
	// RoleSystemAdminReadonly may read every user's sandboxes.
	RoleSystemAdminReadonly = "system-admin-readonly"
	// RoleDefault acts only on the caller's own sandboxes.
	RoleDefault = "default"
)

// Rejection is the answer to a caller whose credential is not accepted.
type Rejection struct {
	Status  int
	Code    string
	Message string
}

// APIKeyHeader is the header an E2B or platform client uses for its API key.
const APIKeyHeader = "X-API-KEY"

// MissingCredential is the answer to a request without a bearer credential or an API key.
var MissingCredential = Rejection{
	Status:  http.StatusUnauthorized,
	Code:    "caller_credentials_missing",
	Message: "authentication required: use Authorization: Bearer <API key or access token> or X-API-KEY",
}

// BearerCredential returns the credential of an "Authorization: Bearer" header value, or "".
func BearerCredential(header string) string {
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// CallerCredential returns the credential of a /v1 request. A bearer token
// wins when both are present: an access token is the primary credential, and
// X-API-KEY is the fallback.
func CallerCredential(h http.Header) string {
	if credential := BearerCredential(h.Get("Authorization")); credential != "" {
		return credential
	}
	return strings.TrimSpace(h.Get(APIKeyHeader))
}

// E2BKey returns the credential of an E2B request. E2B clients send X-API-KEY
// and may also send an access token as Authorization. X-API-KEY wins, and a
// bearer token is used only when X-API-KEY is empty.
func E2BKey(h http.Header) string {
	if key := strings.TrimSpace(h.Get(APIKeyHeader)); key != "" {
		return key
	}
	return BearerCredential(h.Get("Authorization"))
}

// RejectionFor maps an Introspect error to the caller's answer: 401 for an
// inactive credential, 503 when the identity provider cannot answer.
func RejectionFor(err error) Rejection {
	if errors.Is(err, ErrInactive) {
		return Rejection{
			Status:  http.StatusUnauthorized,
			Code:    "caller_credential_invalid",
			Message: "credential verification failed: invalid or expired credential",
		}
	}
	return Rejection{
		Status:  http.StatusServiceUnavailable,
		Code:    "caller_auth_unavailable",
		Message: "identity provider is unavailable",
	}
}

// PlatformRole picks the highest-priority role from the introspected roles.
// The roles are the platform roles the identity provider reads from its store (the
// platform groups plus "default"), so they are taken as the caller's role.
// Priority: system-admin > system-admin-readonly > default.
func PlatformRole(roles []string) string {
	best := RoleDefault
	for _, r := range roles {
		switch r {
		case RoleSystemAdmin:
			return RoleSystemAdmin
		case RoleSystemAdminReadonly:
			best = RoleSystemAdminReadonly
		}
	}
	return best
}
