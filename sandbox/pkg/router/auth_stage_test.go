// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// proxyToUpstream wires one route straight at proxyRequest with a real signer,
// so the request reaches the stand-in EnvD instead of failing closed at 503.
func proxyToUpstream(t *testing.T, upstreamURL string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	mgr, err := NewJWTManager(nil)
	require.NoError(t, err)

	s := &Server{jwt: mgr}
	engine := gin.New()
	engine.GET("/proxy", func(c *gin.Context) {
		s.proxyRequest(c, upstreamURL, "session-1")
	})
	return engine
}

// The incident this labelling exists for: EnvD rejects the Router's own JWT,
// the status is passed through untouched, and the operator reads a 401 as "the
// user's credential expired" -- when the caller's credential never reached the
// sandbox, because proxyRequest overwrites Authorization before sending.
func TestEnvDRejectionIsLabelledAsTheRoutersOwnCredential(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// EnvD only ever sees the Router's token.
			assert.NotEmpty(t, r.Header.Get("Authorization"))
			w.WriteHeader(status)
		}))
		defer upstream.Close()

		rec := httptest.NewRecorder()
		proxyToUpstream(t, upstream.URL).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/proxy", nil))

		assert.Equal(t, status, rec.Code, "status is passed through, so client behaviour is unchanged")
		assert.Equal(t, authStageEnvD, rec.Header().Get(authStageHeader),
			"a %d from the sandbox must not be readable as a caller credential failure", status)
	}
}

// The two stages are the point: same status, different cause, and triage has to
// be able to tell them apart without pattern-matching on error prose.
func TestTheTwoUnauthorizedStagesAreDistinguishable(t *testing.T) {
	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer envd.Close()

	fromEnvD := httptest.NewRecorder()
	proxyToUpstream(t, envd.URL).ServeHTTP(fromEnvD, httptest.NewRequest(http.MethodGet, "/proxy", nil))

	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("SaFE must not be called without a credential")
	})
	fromCaller := httptest.NewRecorder()
	s.engine.ServeHTTP(fromCaller, httptest.NewRequest(http.MethodGet, "/v1/test", nil))

	require.Equal(t, http.StatusUnauthorized, fromEnvD.Code)
	require.Equal(t, http.StatusUnauthorized, fromCaller.Code)
	assert.NotEqual(t,
		fromEnvD.Header().Get(authStageHeader),
		fromCaller.Header().Get(authStageHeader),
		"identical status codes with no way to tell the layers apart is the bug")
	assert.Equal(t, authStageEnvD, fromEnvD.Header().Get(authStageHeader))
	assert.Equal(t, authStageCaller, fromCaller.Header().Get(authStageHeader))
}

// Codes rather than prose, because the messages are free to be reworded and a
// runbook keyed on them silently stops matching.
func TestCallerRejectionsCarryAStableCode(t *testing.T) {
	for _, tc := range []struct {
		name   string
		req    func() *http.Request
		safe   http.HandlerFunc
		status int
		code   string
	}{
		{
			name:   "no credential at all",
			req:    func() *http.Request { return httptest.NewRequest(http.MethodGet, "/v1/test", nil) },
			safe:   func(http.ResponseWriter, *http.Request) {},
			status: http.StatusUnauthorized,
			code:   "caller_credentials_missing",
		},
		{
			name: "api key SaFE refuses",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
				r.Header.Set("Authorization", "Bearer ak-nope")
				return r
			},
			safe:   func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) },
			status: http.StatusUnauthorized,
			code:   "caller_api_key_invalid",
		},
		{
			name: "cookie SaFE refuses",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
				r.AddCookie(&http.Cookie{Name: "Token", Value: "stale"})
				return r
			},
			safe:   func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) },
			status: http.StatusUnauthorized,
			code:   "caller_cookie_invalid",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestRouterWithAuth(t, tc.safe)

			rec := httptest.NewRecorder()
			s.engine.ServeHTTP(rec, tc.req())

			require.Equal(t, tc.status, rec.Code)
			assert.Equal(t, authStageCaller, rec.Header().Get(authStageHeader))

			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, tc.code, body["code"])
		})
	}
}

// The header is diagnostic, not decorative: putting it on healthy responses
// would make it useless as an alert signal.
func TestASuccessfulProxyCarriesNoAuthStage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	proxyToUpstream(t, upstream.URL).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/proxy", nil))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Header().Get(authStageHeader))
}
