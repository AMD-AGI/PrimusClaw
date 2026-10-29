// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestIntrospectActiveInactiveAndUnavailable(t *testing.T) {
	var calls atomic.Int32
	status := atomic.Int32{}
	status.Store(http.StatusOK)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		id, secret, ok := r.BasicAuth()
		if !ok || id != "svc-1" || secret != "s3cret" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if code := int(status.Load()); code != http.StatusOK {
			w.WriteHeader(code)
			return
		}
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		switch r.PostForm.Get("token") {
		case "ak-good":
			_, _ = w.Write([]byte(`{"active":true,"sub":"u-1","email":"a@example.com","roles":["system-admin"]}`))
		default:
			_, _ = w.Write([]byte(`{"active":false}`))
		}
	}))
	defer srv.Close()

	now := time.Unix(1000, 0)
	c := NewClient(srv.URL, "svc-1", "s3cret")
	c.now = func() time.Time { return now }
	ctx := context.Background()

	tok, err := c.Introspect(ctx, "ak-good")
	if err != nil || tok.Subject != "u-1" || tok.Email != "a@example.com" || !tok.HasRole("system-admin") {
		t.Fatalf("active = %+v %v", tok, err)
	}
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) {
		t.Fatalf("inactive err = %v", err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); err != nil || calls.Load() != 2 {
		t.Fatalf("cached active: calls=%d err=%v", calls.Load(), err)
	}
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) || calls.Load() != 2 {
		t.Fatalf("cached inactive: calls=%d err=%v", calls.Load(), err)
	}

	now = now.Add(6 * time.Second)
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) || calls.Load() != 3 {
		t.Fatalf("inactive after 5s: calls=%d err=%v", calls.Load(), err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); err != nil || calls.Load() != 3 {
		t.Fatalf("active within 30s: calls=%d err=%v", calls.Load(), err)
	}

	now = now.Add(30 * time.Second)
	status.Store(http.StatusServiceUnavailable)
	if _, err := c.Introspect(ctx, "ak-good"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("503 err = %v", err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); !errors.Is(err, ErrUnavailable) || calls.Load() != 5 {
		t.Fatalf("503 must not be cached: calls=%d err=%v", calls.Load(), err)
	}
	status.Store(http.StatusOK)
	if _, err := c.Introspect(ctx, "ak-good"); err != nil {
		t.Fatalf("recovered err = %v", err)
	}
}

func TestIntrospectUnreachableIsUnavailable(t *testing.T) {
	c := NewClient("http://127.0.0.1:1/oauth/introspect", "id", "secret")
	if _, err := c.Introspect(context.Background(), "ak-x"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
}
