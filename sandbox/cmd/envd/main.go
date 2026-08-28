// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// envd is the Pod-internal HTTP agent for agent-sandbox.
// It exposes APIs for command execution, persistent sessions (tmux),
// interactive terminals, file operations, and GPU status queries.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"sigs.k8s.io/agent-sandbox/pkg/envd"
)

func main() {
	cfg := envd.DefaultConfig()

	flag.IntVar(&cfg.Port, "port", cfg.Port, "HTTP listen port")
	flag.StringVar(&cfg.Workspace, "workspace", cfg.Workspace, "Workspace root directory for file operations")
	flag.IntVar(&cfg.TMuxWidth, "tmux-width", cfg.TMuxWidth, "tmux window width (columns)")
	flag.IntVar(&cfg.TMuxHeight, "tmux-height", cfg.TMuxHeight, "tmux window height (rows)")
	flag.Parse()

	// §4.1: Egress proxy feature gate (controlled by Helm values → Pod env)
	if v := os.Getenv("EGRESS_ENABLED"); strings.EqualFold(v, "true") || v == "1" {
		cfg.EgressEnabled = true
		if extra := os.Getenv("EGRESS_EXTRA_BLOCKED_CIDRS"); extra != "" {
			cfg.ExtraBlockCIDRs = strings.Split(extra, ",")
		}
	}

	// Ensure workspace exists
	if err := os.MkdirAll(cfg.Workspace, 0755); err != nil {
		slog.Error("failed to create workspace", "path", cfg.Workspace, "error", err)
		os.Exit(1)
	}

	srv, err := envd.New(cfg)
	if err != nil {
		slog.Error("failed to initialize envd", "error", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	slog.Info("envd starting",
		"port", cfg.Port,
		"workspace", cfg.Workspace,
		"egressEnabled", cfg.EgressEnabled)

	if err := srv.Run(ctx); err != nil {
		if err.Error() != "http: Server closed" {
			slog.Error("envd exited with error", "error", err)
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}

	slog.Info("envd shutdown complete")
}
