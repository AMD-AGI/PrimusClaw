// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestForwardCallerCredentials(t *testing.T) {
	ctx := withCallerCredentials(
		context.Background(),
		"Bearer safe-user-token",
		"Token=safe-cookie-token; userType=platform",
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://wm/recover", nil)
	require.NoError(t, err)

	forwardCallerCredentials(ctx, req)

	require.Equal(t, "Bearer safe-user-token", req.Header.Get("Authorization"))
	require.Equal(t, "Token=safe-cookie-token; userType=platform", req.Header.Get("Cookie"))
	require.Empty(t, req.Header.Get("userId"))
	require.Empty(t, req.Header.Get("userRole"))
}

func TestRecoverSessionFromWMPreservesOwner(t *testing.T) {
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer safe-user-token", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"sessionId":"sid-1",
			"userId":"owner-1",
			"userName":"Owner",
			"sandboxName":"sandbox-1",
			"namespace":"tenant-1",
			"podIp":"10.0.0.2",
			"podPort":8080,
			"status":"running"
		}`))
	}))
	defer wm.Close()

	manager := &defaultSessionManager{wmURL: wm.URL, httpClient: wm.Client()}
	ctx := withCallerCredentials(context.Background(), "Bearer safe-user-token", "")
	info, err := manager.recoverSessionFromWM(ctx, "sid-1")
	require.NoError(t, err)
	require.Equal(t, "owner-1", info.UserID)
	require.Equal(t, "Owner", info.UserName)
}
