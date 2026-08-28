// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestProxyRequestFailsClosedWhenJWTSigningFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	// A manager without a private key forces GenerateToken to return an error.
	s := &Server{jwt: &JWTManager{}}
	engine := gin.New()
	engine.GET("/proxy", func(c *gin.Context) {
		s.proxyRequest(c, upstream.URL, "session-1")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/proxy", nil)
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Zero(t, upstreamCalls.Load(), "upstream must not receive an unsigned request")
}

func TestProxyRequestFailsClosedWithoutJWTManager(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	s := &Server{}
	engine := gin.New()
	engine.GET("/proxy", func(c *gin.Context) {
		s.proxyRequest(c, upstream.URL, "session-1")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/proxy", nil)
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Zero(t, upstreamCalls.Load())
}
