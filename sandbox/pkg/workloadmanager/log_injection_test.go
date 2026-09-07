// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// An end-to-end check that the logging seam holds on a real code path.
//
// pkg/logx proves the escaping in isolation and pkg/logx's sweep proves nothing
// bypasses it. Neither runs production code. This drives a handler the way a
// request does and reads what reaches the record, so the two guarantees are
// joined by something that would notice if the seam were installed but not
// reached -- a package that imported logx and still logged raw, say.

package workloadmanager

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

const forgedSessionID = "wanted\r\nlevel=ERROR msg=\"cluster is on fire\" userId=admin\x1b[2Kx\x00"

type captureHandler struct {
	mu      sync.Mutex
	records []map[string]string
}

func (h *captureHandler) Enabled(context.Context, slog.Level) bool { return true }

// Handle deliberately does not format: slog's text and JSON handlers escape a
// newline themselves, which would hide an unescaped value behind the handler's
// own quoting and let this test pass on code that logs raw.
func (h *captureHandler) Handle(_ context.Context, r slog.Record) error {
	rec := map[string]string{"msg": r.Message}
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

func (h *captureHandler) recordContaining(t *testing.T, msg string) map[string]string {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, rec := range h.records {
		if strings.Contains(rec["msg"], msg) {
			return rec
		}
	}
	t.Fatalf("no record matching %q; captured %d", msg, len(h.records))
	return nil
}

// The session id arrives on the request and reaches this record whenever the
// indexed lookup cannot answer -- which a cache that has not synced yet makes
// an ordinary occurrence, not an exotic one.
func TestSessionLookupFallbackLogsANeutralizedSessionID(t *testing.T) {
	h := &captureHandler{}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })

	creator := &K8sSandboxCreator{
		client:       indexedClient(t),
		cachedReader: failingReader{err: errors.New("the cache is not started")},
	}
	// The lookup itself finds nothing; the record it emits on the way is the
	// subject here.
	_, _ = creator.findSandboxBySessionID(context.Background(), forgedSessionID)

	got := h.recordContaining(t, "indexed sandbox lookup unavailable")["sessionId"]
	for _, b := range []string{"\n", "\r", "\x00", "\x1b"} {
		if strings.Contains(got, b) {
			t.Errorf("sessionId reached the record carrying %q: %q", b, got)
		}
	}
	if !strings.Contains(got, "<CR><LF>") {
		t.Errorf("the CRLF was dropped rather than marked: %q", got)
	}
	if strings.Contains(got, `\`) {
		t.Errorf("a backslash reached the record; the handler escapes those "+
			"again when it quotes: %q", got)
	}
	if !strings.Contains(got, "wanted") {
		t.Errorf("escaping swallowed the value: %q", got)
	}
}
