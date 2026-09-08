// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package logx is the logging seam for this tree: every log record passes
// through it, and it neutralizes the caller-controlled values inside.
//
// The alternative was wrapping each value at each call site -- cmdlog.Value(x)
// beside every x that might have come from a request. That works, and it was
// tried here first, and it has three faults this package exists to remove.
//
// It is incomplete by construction. Whether a particular value is
// caller-controlled is a judgement made once per call site, and the judgements
// are wrong often enough to matter: an exec request's "timeout" reads like a
// duration and is a string off the request body. Every new log statement is a
// fresh chance to get it wrong, and nothing fails when someone does.
//
// It is untyped. cmdlog.Value takes a string, so a time.Duration or an int64
// beside a key like "timeout" needs an exemption written by hand -- noise that
// says nothing, on lines that were never at risk.
//
// It is noisy. 123 call sites carried the ceremony, and the ceremony is what
// readers of that code have to skip past to see what is being logged.
//
// Here the decision is made once, from the type rather than from a judgement:
// strings and errors are escaped, everything else is passed through untouched.
//
// # Why a seam and not a slog.Handler
//
// A sanitizing slog.Handler is the tidier design and it cannot work. Static
// analysis treats the argument at the call site as the sink -- CodeQL's
// go/log-injection is literally `call.getAValueFormattedMessageComponent()` --
// so anything a handler does afterwards is downstream of the sink and can never
// be a barrier. Every call site stays reported no matter how correct the
// handler is. Escaping has to happen between the caller and the logging call,
// which is what this package is.
package logx

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/go-logr/logr"
	ctrllog "sigs.k8s.io/controller-runtime/pkg/log"

	"sigs.k8s.io/agent-sandbox/pkg/cmdlog"
)

// safeArgs escapes the values that can carry a forged record and leaves the
// rest alone.
//
// Keys go through it as well as values. A key is a constant at every call site
// in this tree, and a constant with nothing to escape comes back unchanged, so
// the cost is a comparison and the benefit is not having to know which
// positions in a variadic list are keys -- slog accepts several shapes.
func safeArgs(args []any) []any {
	if len(args) == 0 {
		return nil
	}
	out := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case string:
			out[i] = cmdlog.Value(v)
		case error:
			out[i] = cmdlog.Err(v)
		default:
			// Numbers, durations, IPs, booleans, structs. None of them can
			// carry a newline into a record, and converting them to strings
			// here would only make the record harder to read.
			out[i] = a
		}
	}
	return out
}

// emitSafe writes a record whose message and arguments are already escaped.
//
// Nothing here escapes a second time. Escaping an escaped string turns `\n`
// into `\\n` and makes a record less readable every time it crosses a layer,
// which is the failure mode that makes people stop reading logs.
//
// It calls slog.Log rather than building a Record and handing it to the
// handler directly. The Record route preserves the caller's source location;
// this one records logx.go instead. That is a real cost, paid deliberately,
// because the Record route is invisible to static analysis: CodeQL recognises
// slog's package-level functions as log sinks and does not recognise
// Handler().Handle(), so on that route it reports nothing here whether or not
// anything is escaped -- which was measured, by deleting every call to
// safeArgs and watching the alert count stay at zero. A green result that
// survives deleting the thing it is meant to check is not a result.
//
// Nothing in this tree enables AddSource today, so the location is unused.
func emitSafe(ctx context.Context, level slog.Level, msg string, args []any) {
	// The strings and errors in args have been through cmdlog on every path
	// that can produce one. What reaches here unescaped is the default branch
	// of safeArgs, which carries numbers, durations, IPs and booleans -- none
	// of which can hold the newline this rule exists to find.
	//
	// The analyzer reports it anyway, and correctly by its own lights: it
	// cannot narrow a type switch, so it treats the pass-through branch as
	// reachable with a tainted string. Verified: the alert is identical with
	// the escaping in place and with every call to safeArgs deleted.
	//
	// The marker below suppresses the alert for the CodeQL CLI and does not
	// suppress it on GitHub: code scanning ingests the analysis without
	// applying in-source suppressions, which was measured on this branch --
	// the CLI reported the alert as suppressed and the same commit came back
	// from Actions with it open. It is kept because it carries the reason to
	// anyone running the CLI, and because it marks the line; the alert itself
	// is dismissed against the repository.
	//
	// Either way it is scoped to this line. A new path through this package
	// that forgets to escape is a different line, and will be reported.
	//
	// codeql[go/log-injection]
	slog.Log(ctx, level, msg, args...)
}

// emit is the structured entry point: it escapes, then hands off.
func emit(ctx context.Context, level slog.Level, msg string, args ...any) {
	emitSafe(ctx, level, cmdlog.Value(msg), safeArgs(args))
}

// Debug, Info, Warn and Error mirror slog's package-level functions.
func Debug(msg string, args ...any) { emit(context.Background(), slog.LevelDebug, msg, args...) }
func Info(msg string, args ...any)  { emit(context.Background(), slog.LevelInfo, msg, args...) }
func Warn(msg string, args ...any)  { emit(context.Background(), slog.LevelWarn, msg, args...) }
func Error(msg string, args ...any) { emit(context.Background(), slog.LevelError, msg, args...) }

// Infof and Warnf mirror klog's printf-style calls.
//
// The arguments are escaped before formatting, not the result after it: the
// format string is a constant at every call site, and escaping the joined
// string would also escape the punctuation the format put there.
func Infof(format string, a ...any) {
	emitSafe(context.Background(), slog.LevelInfo, fmt.Sprintf(format, safeArgs(a)...), nil)
}

func Warnf(format string, a ...any) {
	emitSafe(context.Background(), slog.LevelWarn, fmt.Sprintf(format, safeArgs(a)...), nil)
}

// Verbose is klog's V(n) gate. Level n maps below Debug, so a more verbose
// level is a lower slog level and the ordering klog callers rely on survives.
type Verbose struct {
	level slog.Level
	on    bool
}

func V(level int) Verbose {
	l := slog.LevelDebug - slog.Level(level)
	return Verbose{level: l, on: slog.Default().Enabled(context.Background(), l)}
}

func (v Verbose) Enabled() bool { return v.on }

func (v Verbose) Info(msg string, args ...any) {
	if v.on {
		emit(context.Background(), v.level, msg, args...)
	}
}

func (v Verbose) Infof(format string, a ...any) {
	if v.on {
		emitSafe(context.Background(), v.level, fmt.Sprintf(format, safeArgs(a)...), nil)
	}
}

// Logger is the contextual logger a controller's Reconcile is handed.
//
// The method set matches logr.Logger's, including Error's leading error, so
// changing `log.FromContext(ctx)` to `logx.FromContext(ctx)` is the whole
// migration for a controller -- the call sites below it do not move.
type Logger struct{ l logr.Logger }

// FromContext returns the request-scoped logger, still carrying whatever
// controller-runtime put in it (the reconcile's name and namespace).
//
// Deliberately controller-runtime's FromContext and not logr's
// FromContextOrDiscard: the latter returns a sink that drops every record when
// the context carries no logger, which is a silent loss of logging on any path
// that did not come from a Reconcile. This one falls back to the global logger,
// which is what the call sites had before.
func FromContext(ctx context.Context) Logger {
	return Logger{l: ctrllog.FromContext(ctx)}
}

func (g Logger) Info(msg string, args ...any) {
	g.l.Info(cmdlog.Value(msg), safeArgs(args)...)
}

// Error escapes the error as well as the values beside it. An error message
// routinely quotes the input that produced it, so it carries the same bytes.
func (g Logger) Error(err error, msg string, args ...any) {
	g.l.Error(safeErrorOf(err), cmdlog.Value(msg), safeArgs(args)...)
}

func (g Logger) V(level int) Logger { return Logger{l: g.l.V(level)} }

// Logr exposes the underlying logr.Logger, for the few places that have to
// hand one to a library. Records logged through it are NOT escaped -- that is
// the point of the seam, and this is the way around it. Use it only where a
// third-party signature demands a logr.Logger, and keep request-derived values
// out of what you log with it.
func (g Logger) Logr() logr.Logger { return g.l }

func (g Logger) WithName(name string) Logger { return Logger{l: g.l.WithName(name)} }

func (g Logger) WithValues(args ...any) Logger {
	return Logger{l: g.l.WithValues(safeArgs(args)...)}
}

// safeError carries an already-escaped message. logr renders an error by
// calling Error(), so escaping has to happen before logr sees it.
type safeError struct{ msg string }

func (e safeError) Error() string { return e.msg }

func safeErrorOf(err error) error {
	if err == nil {
		return nil
	}
	return safeError{msg: cmdlog.Err(err)}
}
