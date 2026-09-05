// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package logx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/go-logr/logr"
	"strings"
	"sync"
	"testing"
	"time"

	ctrllog "sigs.k8s.io/controller-runtime/pkg/log"
)

// forgedRecord is what an attacker puts in a request field: a CRLF pair to end
// the real record and open a forged one, an escape sequence to repaint the line
// in a terminal, and a NUL to cut short whatever reads it as a C string.
const forgedRecord = "wanted\r\nlevel=ERROR msg=\"cluster is on fire\" userId=admin\x1b[2Kx\x00"

var rawControlBytes = []string{"\n", "\r", "\t", "\x00", "\x1b", "\x7f"}

// captureHandler records attribute values exactly as they arrive.
//
// It deliberately does not format them: slog's own text and JSON handlers
// escape a value containing a newline, which would hide a missing wrapper
// behind the handler's own escaping and let these tests pass on unfixed code.
// What reaches Handle is what this package chose to log.
type captureHandler struct {
	mu      sync.Mutex
	level   slog.Level
	records []map[string]string
}

func (h *captureHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level }

func (h *captureHandler) Handle(_ context.Context, r slog.Record) error {
	rec := map[string]string{"msg": r.Message, "level": r.Level.String()}
	r.Attrs(func(a slog.Attr) bool {
		rec[a.Key] = a.Value.String()
		return true
	})
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, rec)
	return nil
}

func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *captureHandler) WithGroup(string) slog.Handler      { return h }

func (h *captureHandler) only(t *testing.T) map[string]string {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.records) != 1 {
		t.Fatalf("want exactly 1 record, got %d: %v", len(h.records), h.records)
	}
	return h.records[0]
}

// capture installs the capturing handler as the default logger. Not parallel:
// slog's default logger is process-wide.
func capture(t *testing.T) *captureHandler {
	t.Helper()
	h := &captureHandler{level: slog.LevelDebug - 8}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return h
}

func assertNeutralized(t *testing.T, field, got string) {
	t.Helper()
	for _, b := range rawControlBytes {
		if strings.Contains(got, b) {
			t.Errorf("%s reached the log carrying %q: %q", field, b, got)
		}
	}
	if !strings.Contains(got, "<CR><LF>") {
		t.Errorf("%s lost the CRLF it was given instead of marking it: %q", field, got)
	}
	if strings.Contains(got, `\`) {
		t.Errorf("%s carries a backslash; slog's handler escapes those again "+
			"when it quotes, and the escaping compounds per layer: %q", field, got)
	}
	if !strings.Contains(got, "wanted") {
		t.Errorf("%s no longer contains the value it was logging: %q", field, got)
	}
}

// The whole point of the package: a call site that does nothing special still
// gets a neutralized record.
func TestEveryLevelNeutralizesAValueWithNoCeremonyAtTheCallSite(t *testing.T) {
	for name, fn := range map[string]func(string, ...any){
		"Debug": Debug, "Info": Info, "Warn": Warn, "Error": Error,
	} {
		t.Run(name, func(t *testing.T) {
			h := capture(t)
			fn("probe", "sessionId", forgedRecord)
			assertNeutralized(t, name+" sessionId", h.only(t)["sessionId"])
		})
	}
}

// An error's message routinely quotes the input that produced it, so it carries
// the same bytes the value did and has to be escaped the same way.
func TestErrorValuesAreNeutralizedToo(t *testing.T) {
	h := capture(t)
	Warn("probe", "error", errors.New(forgedRecord))
	assertNeutralized(t, "error", h.only(t)["error"])
}

// Escaping every string would make a record worse than the injection. Only
// what can carry a forged line is touched.
func TestNonStringValuesArePassedThroughUntouched(t *testing.T) {
	h := capture(t)
	Info("probe", "timeout", 30*time.Second, "count", 5, "ok", true)
	rec := h.only(t)
	for k, want := range map[string]string{"timeout": "30s", "count": "5", "ok": "true"} {
		if rec[k] != want {
			t.Errorf("%s = %q, want %q -- a non-string must reach the record as itself", k, rec[k], want)
		}
	}
}

// Printf-style callers escape the arguments, not the formatted result: the
// format string is a constant, and escaping the join would escape its own
// punctuation.
func TestPrintfStyleEscapesTheArgumentsNotTheFormat(t *testing.T) {
	h := capture(t)
	Infof("session %s registered for %s", forgedRecord, "pool-1")
	msg := h.only(t)["msg"]
	assertNeutralized(t, "Infof msg", msg)
	if !strings.Contains(msg, "registered for pool-1") {
		t.Errorf("the format's own text did not survive: %q", msg)
	}
}

func TestVerboseGatesAndStillEscapes(t *testing.T) {
	h := capture(t)
	V(2).Infof("session %s", forgedRecord)
	assertNeutralized(t, "V(2).Infof", h.only(t)["msg"])
}

// A V level above the handler's threshold must emit nothing at all.
func TestVerboseAboveTheThresholdEmitsNothing(t *testing.T) {
	h := &captureHandler{level: slog.LevelInfo}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })

	V(4).Info("should not appear", "sessionId", forgedRecord)
	if len(h.records) != 0 {
		t.Errorf("a gated-out record was emitted anyway: %v", h.records)
	}
}

// --- the logr side, used by controllers ---

// rawSink records what logx handed logr, with no formatting of its own.
//
// funcr was used here first and made the tests useless without failing: it
// renders values through a JSON-ish quoter, so an unescaped newline came back
// as \n anyway and a mutation that deleted the sanitizer stayed green. A sink
// that escapes hides exactly the defect these tests exist to find.
type rawSink struct {
	mu    sync.Mutex
	lines []string
}

func (s *rawSink) Init(logr.RuntimeInfo)          {}
func (s *rawSink) Enabled(int) bool               { return true }
func (s *rawSink) WithName(string) logr.LogSink   { return s }
func (s *rawSink) WithValues(...any) logr.LogSink { return s }

func (s *rawSink) record(msg string, err error, kv []any) {
	var b strings.Builder
	b.WriteString(msg)
	if err != nil {
		b.WriteString(" error=")
		b.WriteString(err.Error())
	}
	for _, v := range kv {
		b.WriteString(" ")
		b.WriteString(fmt.Sprint(v))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = append(s.lines, b.String())
}

func (s *rawSink) Info(_ int, msg string, kv ...any)      { s.record(msg, nil, kv) }
func (s *rawSink) Error(err error, msg string, kv ...any) { s.record(msg, err, kv) }

// controller-runtime's SetLogger takes effect exactly once: Fulfill clears the
// delegating sink's promise, and every later call finds it nil and does
// nothing (controller-runtime v0.24.1, pkg/log/deleg.go:190). So the sink is
// installed once for the whole package and each test reads what it collected.
//
// This cost a wrong diagnosis to find. The fallback test below failed first,
// and the failure looked exactly like FromContext discarding records on a
// context with no logger -- the bug the test exists to catch. It was the
// harness: the second SetLogger was a no-op.
var (
	theSink  = &rawSink{}
	sinkOnce sync.Once
)

func captureLogr(t *testing.T) *[]string {
	t.Helper()
	sinkOnce.Do(func() { ctrllog.SetLogger(logr.New(theSink)) })
	theSink.mu.Lock()
	theSink.lines = nil
	theSink.mu.Unlock()
	return &theSink.lines
}

func TestContextualLoggerNeutralizesValuesAndErrors(t *testing.T) {
	lines := captureLogr(t)
	lg := FromContext(context.Background())
	lg.Info("reconciling", "name", forgedRecord)
	lg.Error(errors.New(forgedRecord), "failed", "claimName", forgedRecord)

	if len(*lines) != 2 {
		t.Fatalf("want 2 records, got %d: %v", len(*lines), *lines)
	}
	for i, got := range *lines {
		for _, b := range rawControlBytes {
			if strings.Contains(got, b) {
				t.Errorf("record %d carried %q raw: %q", i, b, got)
			}
		}
	}
}

// The fallback that logr.FromContextOrDiscard would have broken: a context with
// no logger in it must still reach the global logger, not a discard sink.
func TestContextWithoutALoggerStillLogs(t *testing.T) {
	lines := captureLogr(t)
	FromContext(context.Background()).Info("no logger in this context")
	if len(*lines) == 0 {
		t.Error("a context carrying no logger dropped the record; " +
			"FromContext must fall back to the global logger, not discard")
	}
}

// A nil error is ordinary on a success path and must not panic.
func TestContextualErrorIsNilSafe(t *testing.T) {
	captureLogr(t)
	FromContext(context.Background()).Error(nil, "no error here")
}
