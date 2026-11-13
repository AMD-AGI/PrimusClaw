// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestTemplateWritesNeedSystemAdmin checks that every role may read templates
// and that only system-admin may create, update or delete them.
func TestTemplateWritesNeedSystemAdmin(t *testing.T) {
	requests := []struct {
		method, path, body string
		write              bool
	}{
		{http.MethodGet, "/v1/templates", "", false},
		{http.MethodPost, "/v1/templates", `{"name":"new","namespace":"admitted",` + templateSpec + `}`, true},
		{http.MethodPost, "/v1/templates/stream", `{"name":"new","namespace":"admitted",` + templateSpec + `}`, true},
		{http.MethodPut, "/v1/templates/admitted/" + existingTemplate, `{` + templateSpec + `}`, true},
		{http.MethodDelete, "/v1/templates/admitted/" + existingTemplate, "", true},
	}
	for _, role := range []string{RoleDefault, RoleSystemAdminReadonly, RoleSystemAdmin} {
		for _, rq := range requests {
			t.Run(role+" "+rq.method+" "+rq.path, func(t *testing.T) {
				rig := newWMRig(t, wmAdmitter(t, true), true)
				w := httptest.NewRecorder()
				req := httptest.NewRequest(rq.method, rq.path, strings.NewReader(rq.body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set(UserIDHeader, "user-1")
				req.Header.Set(UserRoleHeader, role)
				rig.s.router.ServeHTTP(w, req)

				denied := w.Code == http.StatusForbidden
				if want := rq.write && role != RoleSystemAdmin; denied != want {
					t.Fatalf("status = %d, want denied=%v: %s", w.Code, want, w.Body.String())
				}
			})
		}
	}
}
