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

// MissingCredential is the answer to a request without a bearer credential.
var MissingCredential = Rejection{
	Status:  http.StatusUnauthorized,
	Code:    "caller_credentials_missing",
	Message: "authentication required: use Authorization: Bearer <API key or access token>",
}

// BearerCredential returns the credential of an "Authorization: Bearer" header value, or "".
func BearerCredential(header string) string {
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
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
// The roles are the platform roles primus-identity reads from its store (the
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
