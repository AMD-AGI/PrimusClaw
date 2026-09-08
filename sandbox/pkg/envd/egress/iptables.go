// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"fmt"
	"syscall"

	"github.com/coreos/go-iptables/iptables"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	proxyPort   = 18080
	natTable    = "nat"
	filterTable = "filter"
	outputChain = "OUTPUT"
	egressChain = "AGENT_SANDBOX_EGRESS"

	// EnvDProxyGID is a dedicated supplementary group added to the EnvD process.
	// iptables --gid-owner matches this GID to exempt EnvD's own outbound traffic
	// from REDIRECT, while user processes (spawned without this group) are captured.
	EnvDProxyGID = 15534
)

// AddEnvDProxyGroup adds EnvDProxyGID to the current process's supplementary
// groups. Must be called before SetupIPTables so iptables rules can match it.
func AddEnvDProxyGroup() error {
	groups, err := syscall.Getgroups()
	if err != nil {
		return fmt.Errorf("getgroups: %w", err)
	}
	for _, g := range groups {
		if g == EnvDProxyGID {
			return nil
		}
	}
	groups = append(groups, EnvDProxyGID)
	if err := syscall.Setgroups(groups); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	log.Info("egress: added envd-proxy supplementary group", "gid", EnvDProxyGID)
	return nil
}

// SetupIPTables configures iptables REDIRECT rules to intercept all outbound
// TCP traffic from user processes and redirect it to the transparent proxy.
// EnvD's own traffic is exempted via --gid-owner matching on EnvDProxyGID.
// Must be called with CAP_NET_ADMIN after AddEnvDProxyGroup.
func SetupIPTables() error {
	ipt, err := iptables.NewWithProtocol(iptables.ProtocolIPv4)
	if err != nil {
		return fmt.Errorf("init iptables: %w", err)
	}

	gid := fmt.Sprintf("%d", EnvDProxyGID)

	major, minor, patch := ipt.GetIptablesVersion()
	log.Info("egress: setting up iptables",
		"gid", gid, "proxyPort", proxyPort,
		"iptablesVersion", fmt.Sprintf("%d.%d.%d", major, minor, patch))

	if err := ensureChain(ipt, natTable, egressChain); err != nil {
		return err
	}

	// Rule 1: Skip loopback destinations (127.0.0.0/8).
	if err := appendUnique(ipt, natTable, egressChain, "-d", "127.0.0.0/8", "-j", "RETURN"); err != nil {
		return fmt.Errorf("loopback skip rule: %w", err)
	}

	// Rule 2: Skip traffic from processes that carry the envd-proxy supplementary
	// group. Only EnvD itself has this group; user child processes are spawned
	// with Groups=[0] so their traffic gets redirected.
	if err := appendUnique(ipt, natTable, egressChain, "-m", "owner", "--gid-owner", gid, "--suppl-groups", "-j", "RETURN"); err != nil {
		return fmt.Errorf("gid skip rule: %w", err)
	}

	// Rule 3: Skip DNS-over-TCP (port 53) so ClusterDNS on private IPs still works.
	if err := appendUnique(ipt, natTable, egressChain, "-p", "tcp", "--dport", "53", "-j", "RETURN"); err != nil {
		return fmt.Errorf("dns tcp skip rule: %w", err)
	}

	// Rule 4: Redirect all remaining outbound TCP to transparent proxy port.
	if err := appendUnique(ipt, natTable, egressChain, "-p", "tcp", "-j", "REDIRECT", "--to-ports", fmt.Sprintf("%d", proxyPort)); err != nil {
		return fmt.Errorf("redirect rule: %w", err)
	}

	// Jump from OUTPUT to our chain (only for TCP, avoids matching UDP/ICMP).
	if err := appendUnique(ipt, natTable, outputChain, "-p", "tcp", "-j", egressChain); err != nil {
		return fmt.Errorf("output chain jump: %w", err)
	}

	log.Info("egress: iptables v4 rules configured")

	// Block all non-loopback IPv6 outbound TCP from non-EnvD processes.
	if err := setupIPv6Drop(gid); err != nil {
		log.Warn("egress: ip6tables setup failed (non-fatal, IPv6 may not be available)", "error", err)
	}

	return nil
}

// setupIPv6Drop blocks all outbound IPv6 TCP except loopback and EnvD's own traffic.
func setupIPv6Drop(gid string) error {
	ipt6, err := iptables.NewWithProtocol(iptables.ProtocolIPv6)
	if err != nil {
		return fmt.Errorf("init ip6tables: %w", err)
	}

	if err := ensureChain(ipt6, filterTable, egressChain); err != nil {
		return err
	}
	if err := appendUnique(ipt6, filterTable, egressChain, "-d", "::1/128", "-j", "RETURN"); err != nil {
		return fmt.Errorf("ipv6 loopback skip: %w", err)
	}
	if err := appendUnique(ipt6, filterTable, egressChain, "-m", "owner", "--gid-owner", gid, "--suppl-groups", "-j", "RETURN"); err != nil {
		return fmt.Errorf("ipv6 gid skip: %w", err)
	}
	if err := appendUnique(ipt6, filterTable, egressChain, "-p", "tcp", "-j", "DROP"); err != nil {
		return fmt.Errorf("ipv6 tcp drop: %w", err)
	}
	if err := appendUnique(ipt6, filterTable, outputChain, "-p", "tcp", "-j", egressChain); err != nil {
		return fmt.Errorf("ipv6 output jump: %w", err)
	}

	log.Info("egress: ip6tables DROP rules configured")
	return nil
}

// CleanupIPTables removes the egress redirect rules. Best-effort, logs errors.
func CleanupIPTables() {
	if ipt, err := iptables.NewWithProtocol(iptables.ProtocolIPv4); err == nil {
		_ = ipt.Delete(natTable, outputChain, "-p", "tcp", "-j", egressChain)
		_ = ipt.ClearAndDeleteChain(natTable, egressChain)
	}
	if ipt6, err := iptables.NewWithProtocol(iptables.ProtocolIPv6); err == nil {
		_ = ipt6.Delete(filterTable, outputChain, "-p", "tcp", "-j", egressChain)
		_ = ipt6.ClearAndDeleteChain(filterTable, egressChain)
	}
	log.Info("egress: iptables rules cleaned up")
}

func ensureChain(ipt *iptables.IPTables, table, chain string) error {
	exists, err := ipt.ChainExists(table, chain)
	if err != nil {
		return fmt.Errorf("check chain %s: %w", chain, err)
	}
	if !exists {
		if err := ipt.NewChain(table, chain); err != nil {
			return fmt.Errorf("create chain %s: %w", chain, err)
		}
	}
	return nil
}

func appendUnique(ipt *iptables.IPTables, table, chain string, args ...string) error {
	exists, err := ipt.Exists(table, chain, args...)
	if err != nil {
		return fmt.Errorf("check rule: %w", err)
	}
	if exists {
		return nil
	}
	return ipt.Append(table, chain, args...)
}
