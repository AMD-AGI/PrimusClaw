// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestDefaultPolicyEvaluator_AlwaysAllow(t *testing.T) {
	p := &DefaultPolicyEvaluator{}
	d := p.Evaluate(context.Background(), EgressRequest{
		OriginalIP:   net.ParseIP("8.8.8.8"),
		OriginalPort: 443,
		Domain:       "dns.google",
		IsTLS:        true,
	})
	if d.Action != "allow" {
		t.Errorf("expected allow, got %s", d.Action)
	}
}

func TestProxyConfig_Defaults(t *testing.T) {
	cfg := DefaultProxyConfig()
	if cfg.ListenAddr != "127.0.0.1:18080" {
		t.Errorf("ListenAddr=%s, want 127.0.0.1:18080", cfg.ListenAddr)
	}
	if cfg.DialTimeout != 10*time.Second {
		t.Errorf("DialTimeout=%v, want 10s", cfg.DialTimeout)
	}
	if cfg.IdleTimeout != 5*time.Minute {
		t.Errorf("IdleTimeout=%v, want 5m", cfg.IdleTimeout)
	}
}

func TestNewTransparentProxy_WithExtraCIDRs(t *testing.T) {
	cfg := DefaultProxyConfig()
	cfg.ExtraBlockCIDRs = []string{"169.254.0.0/16"}

	proxy, err := NewTransparentProxy(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}

	res := proxy.SSRFChecker().Check(net.ParseIP("169.254.169.254"))
	if !res.Blocked {
		t.Error("169.254.169.254 should be blocked with extra CIDRs")
	}
}

func TestNewTransparentProxy_InvalidCIDR(t *testing.T) {
	cfg := DefaultProxyConfig()
	cfg.ExtraBlockCIDRs = []string{"invalid"}

	_, err := NewTransparentProxy(cfg, nil)
	if err == nil {
		t.Error("expected error for invalid CIDR")
	}
}

func TestTransparentProxy_ListenAndShutdown(t *testing.T) {
	cfg := DefaultProxyConfig()
	cfg.ListenAddr = "127.0.0.1:0" // random port

	proxy, err := NewTransparentProxy(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- proxy.Run(ctx)
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("Run returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not shut down in time")
	}
}

func TestBiCopy_EchoServer(t *testing.T) {
	// Start a simple TCP echo server.
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()

	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1024)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						c.Write(buf[:n])
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()

	// Connect a client pair through biCopy.
	clientConn, proxyConn := net.Pipe()
	upstream, err := net.Dial("tcp", echoLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		biCopy(proxyConn, upstream, proxyConn, 2*time.Second)
		close(done)
	}()

	// Write through client side, expect echo back.
	msg := []byte("hello-egress-proxy")
	if _, err := clientConn.Write(msg); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 128)
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := clientConn.Read(buf)
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf[:n]) != string(msg) {
		t.Errorf("echo=%q, want %q", string(buf[:n]), string(msg))
	}

	clientConn.Close()
	upstream.Close()
	<-done
}
