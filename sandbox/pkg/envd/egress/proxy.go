// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// PolicyEvaluator is the extension point for OPA policy evaluation (Phase 4).
// The transparent proxy calls Evaluate after SSRF checks pass. Phase 3 uses
// DefaultPolicyEvaluator which allows all traffic.
type PolicyEvaluator interface {
	Evaluate(ctx context.Context, req EgressRequest) Decision
}

// EgressRequest describes an outbound connection for policy evaluation.
type EgressRequest struct {
	OriginalIP   net.IP
	OriginalPort int
	Domain       string // from SNI or Host header; may be empty
	ResolvedIP   net.IP // after DNS resolution; may equal OriginalIP
	IsTLS        bool
}

// Decision is the policy evaluation outcome.
type Decision struct {
	Action string // "allow", "deny", "audit"
	Reason string
}

// DefaultPolicyEvaluator always allows traffic (SSRF check is the only gate).
type DefaultPolicyEvaluator struct{}

// Evaluate always returns allow. Phase 4 will replace this with OPA evaluation.
func (d *DefaultPolicyEvaluator) Evaluate(_ context.Context, _ EgressRequest) Decision {
	return Decision{Action: "allow"}
}

// ProxyConfig holds configuration for the transparent proxy.
type ProxyConfig struct {
	ListenAddr      string        // default "127.0.0.1:18080"
	DialTimeout     time.Duration // TCP connect timeout to upstream
	IdleTimeout     time.Duration // close connection after no data in either direction
	ExtraBlockCIDRs []string      // extra CIDRs to block (from Helm values)
}

// DefaultProxyConfig returns sensible defaults.
func DefaultProxyConfig() ProxyConfig {
	return ProxyConfig{
		ListenAddr:  fmt.Sprintf("127.0.0.1:%d", proxyPort),
		DialTimeout: 10 * time.Second,
		IdleTimeout: 5 * time.Minute,
	}
}

// TransparentProxy intercepts outbound TCP connections redirected by iptables
// and enforces SSRF protection + policy evaluation before forwarding.
type TransparentProxy struct {
	cfg      ProxyConfig
	ssrf     *SSRFChecker
	resolver *SafeResolver
	policy   PolicyEvaluator
	reporter EventReporter
	listener net.Listener

	mu      sync.Mutex
	stopped bool
}

// NewTransparentProxy creates a proxy with the given config and policy evaluator.
// If policy is nil, DefaultPolicyEvaluator is used.
func NewTransparentProxy(cfg ProxyConfig, policy PolicyEvaluator) (*TransparentProxy, error) {
	ssrf, err := NewSSRFChecker(cfg.ExtraBlockCIDRs)
	if err != nil {
		return nil, fmt.Errorf("init ssrf checker: %w", err)
	}

	if policy == nil {
		policy = &DefaultPolicyEvaluator{}
	}

	return &TransparentProxy{
		cfg:      cfg,
		ssrf:     ssrf,
		resolver: NewSafeResolver(ssrf),
		policy:   policy,
	}, nil
}

// SSRFChecker returns the underlying SSRF checker for allow-list updates.
func (p *TransparentProxy) SSRFChecker() *SSRFChecker {
	return p.ssrf
}

// Run starts the TCP listener and blocks until ctx is cancelled.
func (p *TransparentProxy) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", p.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", p.cfg.ListenAddr, err)
	}
	p.listener = ln
	log.Info("egress: transparent proxy listening", "addr", p.cfg.ListenAddr)

	go func() {
		<-ctx.Done()
		p.mu.Lock()
		p.stopped = true
		p.mu.Unlock()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			p.mu.Lock()
			stopped := p.stopped
			p.mu.Unlock()
			if stopped {
				return nil
			}
			log.Warn("egress: accept error", "error", err)
			continue
		}
		go p.handleConn(ctx, conn)
	}
}

func (p *TransparentProxy) handleConn(ctx context.Context, clientConn net.Conn) {
	defer clientConn.Close()

	// Step 1: Get the original destination via SO_ORIGINAL_DST.
	origIP, origPort, err := GetOriginalDst(clientConn)
	if err != nil {
		log.Warn("egress: SO_ORIGINAL_DST failed, dropping connection",
			"error", err, "remote", clientConn.RemoteAddr())
		return
	}

	// Step 2: SSRF check on the original destination IP.
	chk := p.ssrf.Check(origIP)
	if chk.Blocked {
		log.Warn("egress: blocked by SSRF check",
			"ip", origIP, "port", origPort,
			"reason", chk.Reason, "cidr", chk.CIDR)
		p.reportDecision(DecisionEvent{
			Action:     "deny",
			Reason:     chk.Reason,
			Stage:      "ssrf",
			OriginalIP: origIP.String(),
			ResolvedIP: origIP.String(),
			Port:       origPort,
		})
		return
	}

	// Step 3: Peek protocol to extract domain (SNI/Host).
	// Set a read deadline to prevent slowloris-style attacks where the client
	// connects but never sends data, blocking the peek indefinitely.
	clientConn.SetReadDeadline(time.Now().Add(10 * time.Second))
	peek := PeekClientDomain(clientConn)
	clientConn.SetReadDeadline(time.Time{}) // clear deadline for subsequent forwarding
	domain := peek.Domain
	dialAddr := net.JoinHostPort(origIP.String(), fmt.Sprintf("%d", origPort))

	// Step 4: If we have a domain, resolve it and validate the resolved IP
	// to prevent DNS rebinding. Then use the verified IP for dialing.
	var resolvedIP net.IP
	if domain != "" {
		addr, err := p.resolver.ResolveAndDial(ctx, domain, origPort)
		if err != nil {
			log.Warn("egress: DNS resolve/validate failed",
				"domain", domain, "error", err)
			p.reportDecision(DecisionEvent{
				Action:     "deny",
				Reason:     err.Error(),
				Stage:      "dns",
				Domain:     domain,
				OriginalIP: origIP.String(),
				Port:       origPort,
				IsTLS:      peek.IsTLS,
			})
			return
		}
		dialAddr = addr

		host, _, _ := net.SplitHostPort(addr)
		resolvedIP = net.ParseIP(host)
	} else {
		resolvedIP = origIP
	}
	resolvedIPStr := ""
	if resolvedIP != nil {
		resolvedIPStr = resolvedIP.String()
	}

	// Step 5: Policy evaluation (extension point for Phase 4 OPA).
	decision := p.policy.Evaluate(ctx, EgressRequest{
		OriginalIP:   origIP,
		OriginalPort: origPort,
		Domain:       domain,
		ResolvedIP:   resolvedIP,
		IsTLS:        peek.IsTLS,
	})
	if decision.Action == "deny" {
		log.Warn("egress: denied by policy",
			"domain", domain, "ip", origIP, "reason", decision.Reason)
		p.reportDecision(DecisionEvent{
			Action:     decision.Action,
			Reason:     decision.Reason,
			Stage:      "policy",
			Domain:     domain,
			OriginalIP: origIP.String(),
			ResolvedIP: resolvedIPStr,
			Port:       origPort,
			IsTLS:      peek.IsTLS,
		})
		return
	}
	if decision.Action == "audit" {
		log.Info("egress: audit (would deny)",
			"domain", domain, "ip", origIP, "reason", decision.Reason)
		p.reportDecision(DecisionEvent{
			Action:     decision.Action,
			Reason:     decision.Reason,
			Stage:      "policy",
			Domain:     domain,
			OriginalIP: origIP.String(),
			ResolvedIP: resolvedIPStr,
			Port:       origPort,
			IsTLS:      peek.IsTLS,
		})
	}

	// Step 6: Dial the upstream using the verified IP.
	upstream, err := net.DialTimeout("tcp", dialAddr, p.cfg.DialTimeout)
	if err != nil {
		log.Warn("egress: dial upstream failed",
			"addr", dialAddr, "error", err)
		return
	}
	defer upstream.Close()

	log.Debug("egress: forwarding",
		"domain", domain, "dial", dialAddr, "tls", peek.IsTLS)

	// Step 7: Bidirectional copy with idle timeout.
	biCopy(peek.Reader, upstream, clientConn, p.cfg.IdleTimeout)
}

// biCopy performs bidirectional data transfer between client and upstream.
// Both goroutines share a deadline-based idle timeout: any data in either
// direction resets the timer for both sides.
func biCopy(clientReader io.Reader, upstream, client net.Conn, idleTimeout time.Duration) {
	var wg sync.WaitGroup
	wg.Add(2)

	resetIdle := func() {
		deadline := time.Now().Add(idleTimeout)
		_ = upstream.SetDeadline(deadline)
		_ = client.SetDeadline(deadline)
	}
	resetIdle()

	// client → upstream
	go func() {
		defer wg.Done()
		copyWithIdle(upstream, clientReader, resetIdle)
		closeWrite(upstream)
	}()

	// upstream → client
	go func() {
		defer wg.Done()
		copyWithIdle(client, upstream, resetIdle)
		closeWrite(client)
	}()

	wg.Wait()
}

func closeWrite(conn net.Conn) {
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
}

func copyWithIdle(dst io.Writer, src io.Reader, resetIdle func()) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			resetIdle()
			if _, wErr := dst.Write(buf[:n]); wErr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
