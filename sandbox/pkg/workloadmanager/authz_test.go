// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestCanMutateSandbox(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name   string
		userID string
		role   string
		owner  string
		want   bool
	}{
		{name: "owner", userID: "alice", role: RoleDefault, owner: "alice", want: true},
		{name: "other tenant", userID: "bob", role: RoleDefault, owner: "alice", want: false},
		{name: "full admin", userID: "root", role: RoleSystemAdmin, owner: "alice", want: true},
		{name: "readonly admin", userID: "auditor", role: RoleSystemAdminReadonly, owner: "alice", want: false},
		{name: "unowned ordinary", userID: "alice", role: RoleDefault, owner: "", want: false},
		{name: "unowned full admin", userID: "root", role: RoleSystemAdmin, owner: "", want: true},
		{name: "auth disabled", owner: "alice", want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("GET", "/", nil)
			if tc.userID != "" {
				c.Request.Header.Set(UserIDHeader, tc.userID)
				c.Request.Header.Set(UserRoleHeader, tc.role)
			}
			require.Equal(t, tc.want, canMutateSandbox(c, tc.owner))
		})
	}
}
