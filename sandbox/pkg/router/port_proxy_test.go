// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// ── Path parsing tests ──────────────────────────────────────────────────────

func TestParsePortProxyPath(t *testing.T) {
	tests := []struct {
		path    string
		port    int
		subPath string
		wantErr bool
	}{
		{"/proxy/8000/", 8000, "/", false},
		{"/proxy/8000/api/data", 8000, "/api/data", false},
		{"/proxy/3000/", 3000, "/", false},
		{"/proxy/443/a/b/c", 443, "/a/b/c", false},
		{"/proxy/8000", 8000, "/", false},
		// errors
		{"/proxy/0/", 0, "", true},       // port 0
		{"/proxy/70000/", 0, "", true},   // port out of range
		{"/proxy/8080/", 0, "", true},    // EnvD reserved port
		{"/proxy/abc/", 0, "", true},     // non-numeric
		{"/proxy//", 0, "", true},        // empty port
		{"/notproxy/8000/", 0, "", true}, // wrong prefix
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			port, subPath, err := parsePortProxyPath(tt.path)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.port, port)
			assert.Equal(t, tt.subPath, subPath)
		})
	}
}

func TestParsePortTunnelPath(t *testing.T) {
	tests := []struct {
		path    string
		port    int
		wantErr bool
	}{
		{"/tunnel/8000", 8000, false},
		{"/tunnel/8000/", 8000, false},
		{"/tunnel/3000", 3000, false},
		// errors
		{"/tunnel/8080", 0, true},    // EnvD reserved
		{"/tunnel/0", 0, true},       // port 0
		{"/tunnel/abc", 0, true},     // non-numeric
		{"/nottunnel/8000", 0, true}, // wrong prefix
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			port, err := parsePortTunnelPath(tt.path)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.port, port)
		})
	}
}

func TestValidatePort(t *testing.T) {
	assert.NoError(t, validatePort(1))
	assert.NoError(t, validatePort(65535))
	assert.NoError(t, validatePort(3000))
	assert.Error(t, validatePort(0))
	assert.Error(t, validatePort(-1))
	assert.Error(t, validatePort(65536))
	assert.Error(t, validatePort(8080)) // EnvD
}

// ── HTTP port proxy integration test ─────────────────────────────────────────

func TestHandlePortProxy_HTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/hello", r.URL.Path)
		assert.Empty(t, r.Header.Get("x-session-id"), "session-id must not leak")
		assert.Empty(t, r.Header.Get("Authorization"), "auth must not leak")
		w.Header().Set("X-Custom", "from-upstream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "hello from sandbox")
	}))
	defer upstream.Close()

	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	var port int
	fmt.Sscanf(portStr, "%d", &port)

	info := &store.SandboxInfo{SessionID: "test-session", PodIP: host}
	s := &Server{}

	engine := gin.New()
	engine.GET("/proxy", func(c *gin.Context) {
		c.Request.Header.Set("x-session-id", "test-session")
		c.Request.Header.Set("Authorization", "Bearer secret-jwt")
		s.handlePortProxy(c, info, port, "/hello")
	})
	ts := httptest.NewServer(engine)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/proxy")
	require.NoError(t, err)
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "hello from sandbox", string(body))
	assert.Equal(t, "from-upstream", resp.Header.Get("X-Custom"))
}

func TestHandlePortProxy_SSE(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		require.True(t, ok)
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "data: event-%d\n\n", i)
			flusher.Flush()
		}
	}))
	defer upstream.Close()

	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	var port int
	fmt.Sscanf(portStr, "%d", &port)

	info := &store.SandboxInfo{SessionID: "sse-test", PodIP: host}
	s := &Server{}

	engine := gin.New()
	engine.GET("/sse", func(c *gin.Context) {
		s.handlePortProxy(c, info, port, "/")
	})
	ts := httptest.NewServer(engine)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/sse")
	require.NoError(t, err)
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, string(body), "data: event-0")
	assert.Contains(t, string(body), "data: event-2")
	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
}

// ── WebSocket tunnel integration test ────────────────────────────────────────

func TestHandleTunnel_Echo(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// TCP echo server (simulates a service inside the sandbox pod)
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer tcpListener.Close()

	go func() {
		for {
			conn, err := tcpListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(c, c)
			}(conn)
		}
	}()

	_, tcpPortStr, _ := net.SplitHostPort(tcpListener.Addr().String())
	var tcpPort int
	fmt.Sscanf(tcpPortStr, "%d", &tcpPort)

	info := &store.SandboxInfo{SessionID: "tunnel-test", PodIP: "127.0.0.1"}
	s := &Server{}

	engine := gin.New()
	engine.GET("/tunnel", func(c *gin.Context) {
		s.handleTunnel(c, info, tcpPort)
	})
	ts := httptest.NewServer(engine)
	defer ts.Close()

	// Connect WebSocket client
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/tunnel"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer ws.Close()

	// Send data through the tunnel
	testData := []byte("hello tunnel")
	err = ws.WriteMessage(websocket.BinaryMessage, testData)
	require.NoError(t, err)

	// Read echo back
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := ws.ReadMessage()
	require.NoError(t, err)
	assert.Equal(t, testData, msg)
}

// ── CheckOrigin test ─────────────────────────────────────────────────────────

func TestWsUpgrader_CheckOrigin(t *testing.T) {
	tests := []struct {
		name   string
		host   string
		origin string
		expect bool
	}{
		{"no origin", "router.example.com", "", true},
		{"same origin", "router.example.com", "https://router.example.com", true},
		{"cross origin", "router.example.com", "https://evil.com", false},
		{"malformed origin", "router.example.com", "://bad", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &http.Request{Host: tt.host, Header: http.Header{}}
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			assert.Equal(t, tt.expect, wsUpgrader.CheckOrigin(r))
		})
	}
}

// ── Route integration test (handleInvoke dispatches to proxy/tunnel) ─────────

type mockSessionManager struct {
	info *store.SandboxInfo
}

func (m *mockSessionManager) GetSandboxBySession(_ context.Context, sessionID, _, _, _ string) (*store.SandboxInfo, error) {
	if sessionID == m.info.SessionID {
		return m.info, nil
	}
	return nil, fmt.Errorf("session %q not found", sessionID)
}

func TestHandleInvoke_ProxyRouting(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "OK:"+r.URL.Path)
	}))
	defer upstream.Close()

	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))

	memStore := store.NewMemoryStore()
	info := &store.SandboxInfo{
		SessionID: "sid-123",
		PodIP:     host,
		PodPort:   8080,
	}
	ctx := context.Background()
	_ = memStore.StoreSandbox(ctx, info)

	s := &Server{
		cfg:            Config{},
		store:          memStore,
		sessionManager: &mockSessionManager{info: info},
	}

	s.engine = gin.New()
	s.engine.GET("/v1/namespaces/:namespace/code-interpreters/:name/invocations/*path",
		s.handleCodeInterpreterInvoke)

	ts := httptest.NewServer(s.engine)
	defer ts.Close()

	client := ts.Client()

	// Test: /proxy/{port}/path → port proxy
	req, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/v1/namespaces/default/code-interpreters/test/invocations/proxy/"+portStr+"/foo", nil)
	req.Header.Set("x-session-id", "sid-123")
	resp, err := client.Do(req)
	require.NoError(t, err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "OK:/foo", string(body))

	// Test: invalid port → 400
	req2, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/v1/namespaces/default/code-interpreters/test/invocations/proxy/8080/", nil)
	req2.Header.Set("x-session-id", "sid-123")
	resp2, err := client.Do(req2)
	require.NoError(t, err)
	resp2.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp2.StatusCode)

	// Test: session not found → 404
	req3, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/v1/namespaces/default/code-interpreters/test/invocations/proxy/"+portStr+"/", nil)
	req3.Header.Set("x-session-id", "nonexistent-session")
	resp3, err := client.Do(req3)
	require.NoError(t, err)
	resp3.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp3.StatusCode)
}

func TestHandleInvoke_EnforcesSandboxOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cases := []struct {
		name       string
		ownerID    string
		callerID   string
		callerRole string
		wantStatus int
	}{
		{name: "owner", ownerID: "alice", callerID: "alice", callerRole: "default", wantStatus: http.StatusBadRequest},
		{name: "other tenant", ownerID: "alice", callerID: "bob", callerRole: "default", wantStatus: http.StatusForbidden},
		{name: "full admin", ownerID: "alice", callerID: "root", callerRole: "system-admin", wantStatus: http.StatusBadRequest},
		{name: "readonly admin", ownerID: "alice", callerID: "auditor", callerRole: "system-admin-readonly", wantStatus: http.StatusForbidden},
		{name: "unowned ordinary", ownerID: "", callerID: "bob", callerRole: "default", wantStatus: http.StatusForbidden},
		{name: "unowned full admin", ownerID: "", callerID: "root", callerRole: "system-admin", wantStatus: http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info := &store.SandboxInfo{
				SessionID: "sid-authz",
				UserID:    tc.ownerID,
				PodIP:     "127.0.0.1",
				PodPort:   8080,
			}
			s := &Server{
				cfg:            Config{EnableAuth: true},
				store:          store.NewMemoryStore(),
				sessionManager: &mockSessionManager{info: info},
			}
			s.jwt, _ = NewJWTManager(nil)
			s.engine = gin.New()
			s.engine.Use(func(c *gin.Context) {
				c.Set("userId", tc.callerID)
				c.Set("userRole", tc.callerRole)
				c.Next()
			})
			s.engine.GET("/v1/namespaces/:namespace/code-interpreters/:name/invocations/*path",
				s.handleCodeInterpreterInvoke)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(
				http.MethodGet,
				"/v1/namespaces/default/code-interpreters/test/invocations/proxy/not-a-port/",
				nil,
			)
			req.Header.Set("x-session-id", "sid-authz")
			s.engine.ServeHTTP(rec, req)

			assert.Equal(t, tc.wantStatus, rec.Code)
		})
	}
}
