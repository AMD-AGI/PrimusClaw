// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// reservedPorts lists ports that cannot be proxied.
// 8080 is EnvD — proxying to it would bypass JWT authentication.
var reservedPorts = map[int]string{
	8080: "EnvD",
}

const tunnelIdleTimeout = 5 * time.Minute

var portProxyTransport = &http.Transport{
	DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   10,
	IdleConnTimeout:       90 * time.Second,
	ResponseHeaderTimeout: 2 * time.Minute,
}

// wsUpgrader validates Origin against the request Host to prevent CSRF
// when Cookie-based auth is enabled.
var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			slog.Warn("tunnel: rejected invalid Origin header",
				"origin", origin, "host", r.Host)
			return false
		}
		if u.Host != r.Host {
			slog.Warn("tunnel: Origin/Host mismatch",
				"origin", origin, "host", r.Host)
			return false
		}
		return true
	},
}

// parsePortProxyPath extracts port and subPath from "/proxy/{port}/{subPath...}".
func parsePortProxyPath(path string) (int, string, error) {
	rest := strings.TrimPrefix(path, "/proxy/")
	if rest == path {
		return 0, "", fmt.Errorf("path does not start with /proxy/")
	}

	parts := strings.SplitN(rest, "/", 2)
	port, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, "", fmt.Errorf("invalid port %q", parts[0])
	}
	if err := validatePort(port); err != nil {
		return 0, "", err
	}

	subPath := "/"
	if len(parts) == 2 {
		subPath = "/" + parts[1]
	}
	return port, subPath, nil
}

// parsePortTunnelPath extracts port from "/tunnel/{port}".
func parsePortTunnelPath(path string) (int, error) {
	rest := strings.TrimPrefix(path, "/tunnel/")
	if rest == path {
		return 0, fmt.Errorf("path does not start with /tunnel/")
	}
	portStr := strings.TrimRight(rest, "/")
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return 0, fmt.Errorf("invalid port %q", portStr)
	}
	if err := validatePort(port); err != nil {
		return 0, err
	}
	return port, nil
}

func validatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("port %d out of range [1, 65535]", port)
	}
	if name, ok := reservedPorts[port]; ok {
		return fmt.Errorf("port %d is reserved for %s", port, name)
	}
	return nil
}

// handlePortProxy reverse-proxies HTTP to podIP:port/subPath.
// Unlike proxyRequest→EnvD, this does NOT inject JWT (target is user service).
// Supports SSE streaming and WebSocket upgrade natively via httputil.ReverseProxy.
func (s *Server) handlePortProxy(c *gin.Context, info *store.SandboxInfo, port int, subPath string) {
	target := &url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort(info.PodIP, strconv.Itoa(port)),
	}
	defer func() {
		status := c.Writer.Status()
		if status == 0 {
			status = http.StatusOK
		}
		portProxyRequests.WithLabelValues(strconv.Itoa(port), strconv.Itoa(status)).Inc()
	}()

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.URL.Path = subPath
			req.Host = target.Host
			// Strip internal headers to prevent credential leakage to user services.
			req.Header.Del("x-session-id")
			req.Header.Del("Authorization")
			req.Header.Del("X-Sandbox-Api-Key")
		},
		Transport:     portProxyTransport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("port proxy: upstream error",
				"podIP", info.PodIP, "port", port, "error", err)
			if gw, ok := w.(gin.ResponseWriter); ok && gw.Written() {
				return
			}
			http.Error(w, fmt.Sprintf("sandbox service unreachable on port %d", port),
				http.StatusBadGateway)
		},
	}

	slog.Debug("port proxy", "sessionId", info.SessionID,
		"podIP", info.PodIP, "port", port, "subPath", subPath)
	proxy.ServeHTTP(c.Writer, c.Request)
}

// handleTunnel upgrades to WebSocket and creates a bidirectional TCP tunnel
// to podIP:port, used by SDK/CLI port_forward.
func (s *Server) handleTunnel(c *gin.Context, info *store.SandboxInfo, port int) {
	wsConn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		slog.Error("tunnel: websocket upgrade failed", "error", err)
		return
	}
	defer wsConn.Close()

	addr := net.JoinHostPort(info.PodIP, strconv.Itoa(port))
	tcpConn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		slog.Error("tunnel: tcp dial failed", "addr", addr, "error", err)
		wsConn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr,
				fmt.Sprintf("cannot connect to port %d", port)))
		return
	}
	defer tcpConn.Close()

	slog.Debug("tunnel established", "sessionId", info.SessionID,
		"podIP", info.PodIP, "port", port)

	var wg sync.WaitGroup
	wg.Add(2)

	// When one direction closes, break the other side's blocking read.
	closeOnce := sync.Once{}
	shutdown := func() {
		closeOnce.Do(func() {
			wsConn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(2*time.Second))
			tcpConn.SetReadDeadline(time.Now())
			wsConn.SetReadDeadline(time.Now())
		})
	}

	resetDeadlines := func() {
		deadline := time.Now().Add(tunnelIdleTimeout)
		wsConn.SetReadDeadline(deadline)
		tcpConn.SetReadDeadline(deadline)
	}
	resetDeadlines()

	// WebSocket → TCP
	go func() {
		defer wg.Done()
		defer shutdown()
		for {
			_, msg, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			resetDeadlines()
			if _, err := tcpConn.Write(msg); err != nil {
				return
			}
		}
	}()

	// TCP → WebSocket
	go func() {
		defer wg.Done()
		defer shutdown()
		buf := make([]byte, 32*1024)
		for {
			n, err := tcpConn.Read(buf)
			if n > 0 {
				resetDeadlines()
				if wErr := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); wErr != nil {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					slog.Debug("tunnel: tcp read error", "error", err)
				}
				return
			}
		}
	}()

	wg.Wait()
}
