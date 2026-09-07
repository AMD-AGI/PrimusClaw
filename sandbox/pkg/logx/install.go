// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package logx

import (
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/go-logr/logr"
	"k8s.io/klog/v2"
	ctrllog "sigs.k8s.io/controller-runtime/pkg/log"
)

// Install points every logging system in this tree at one handler.
//
// Three of them arrived independently and none is a mistake: slog is what the
// service code writes, klog is what the Kubernetes libraries write, and logr is
// what controller-runtime hands a Reconcile. Left alone they have three
// separate destinations, three formats and three level flags, so a level raised
// in one place goes on being ignored by the other two.
//
// logr bridges all three: klog and controller-runtime both accept a
// logr.Logger, and logr.FromSlogHandler builds one from an slog.Handler. After
// this call there is a single handler, a single format and a single level.
//
// This is about where records go, not about what is in them. Escaping happens
// in the seam, before any of these three is called -- a handler runs after the
// point static analysis calls the sink, so it cannot be where the guarantee
// lives. See the package comment.
func Install() { InstallHandler(handlerFromEnv(os.Stderr)) }

// InstallHandler is Install with the handler supplied, for tests and for a
// binary that wants a different format.
func InstallHandler(h slog.Handler) {
	slog.SetDefault(slog.New(h))
	lg := logr.FromSlogHandler(h)
	ctrllog.SetLogger(lg)
	klog.SetLogger(lg)
}

// handlerFromEnv reads LOG_FORMAT (text|json, default text), LOG_LEVEL
// (error|warn|info|debug, default info) and LOG_VERBOSITY.
//
// LOG_VERBOSITY is klog's -v: it selects levels below debug, so V(2) needs
// LOG_VERBOSITY=2. Without it a V(n) record is filtered out, which is what klog
// did with no -v flag.
func handlerFromEnv(w *os.File) slog.Handler {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "error":
		level = slog.LevelError
	case "warn", "warning":
		level = slog.LevelWarn
	case "debug":
		level = slog.LevelDebug
	}
	if v, err := strconv.Atoi(os.Getenv("LOG_VERBOSITY")); err == nil && v > 0 {
		level = slog.LevelDebug - slog.Level(v)
	}

	opts := &slog.HandlerOptions{Level: level}
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "json") {
		return slog.NewJSONHandler(w, opts)
	}
	return slog.NewTextHandler(w, opts)
}
