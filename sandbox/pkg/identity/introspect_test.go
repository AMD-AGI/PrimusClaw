// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testSecret = "s3c+r/et=="

// fakeIdentity answers introspection from a token map and counts calls.
type fakeIdentity struct {
	calls   atomic.Int32
	status  atomic.Int32
	answers map[string]map[string]any
	gate    chan struct{}
}

func (f *fakeIdentity) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	id, secret, ok := r.BasicAuth()
	if !ok || id != "svc-1" || secret != testSecret || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if code := int(f.status.Load()); code != 0 && code != http.StatusOK {
		w.WriteHeader(code)
		return
	}
	_ = r.ParseForm()
	ans, ok := f.answers[r.PostForm.Get("token")]
	if !ok {
		ans = map[string]any{"active": false}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ans)
}

func newTestClient(t *testing.T, f *fakeIdentity, secret string) (*Client, *time.Time) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	now := time.Unix(1000, 0)
	c := NewClient(srv.URL, "svc-1", secret, "")
	c.now = func() time.Time { return now }
	return c, &now
}

func TestIntrospectActiveInactiveAndUnavailable(t *testing.T) {
	f := &fakeIdentity{answers: map[string]map[string]any{
		"ak-good": {"active": true, "sub": "u-1", "email": "a@example.com", "roles": []string{"system-admin"}},
	}}
	c, now := newTestClient(t, f, testSecret)
	ctx := context.Background()

	tok, err := c.Introspect(ctx, "ak-good")
	if err != nil || tok.Subject != "u-1" || tok.Email != "a@example.com" || !tok.HasRole("system-admin") {
		t.Fatalf("active = %+v %v", tok, err)
	}
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) {
		t.Fatalf("inactive err = %v", err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); err != nil || f.calls.Load() != 2 {
		t.Fatalf("cached active: calls=%d err=%v", f.calls.Load(), err)
	}
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) || f.calls.Load() != 2 {
		t.Fatalf("cached inactive: calls=%d err=%v", f.calls.Load(), err)
	}

	*now = now.Add(6 * time.Second)
	if _, err := c.Introspect(ctx, "ak-bad"); !errors.Is(err, ErrInactive) || f.calls.Load() != 3 {
		t.Fatalf("inactive after 5s: calls=%d err=%v", f.calls.Load(), err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); err != nil || f.calls.Load() != 3 {
		t.Fatalf("active within 30s: calls=%d err=%v", f.calls.Load(), err)
	}

	*now = now.Add(30 * time.Second)
	f.status.Store(http.StatusServiceUnavailable)
	if _, err := c.Introspect(ctx, "ak-good"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("503 err = %v", err)
	}
	if _, err := c.Introspect(ctx, "ak-good"); !errors.Is(err, ErrUnavailable) || f.calls.Load() != 5 {
		t.Fatalf("503 must not be cached: calls=%d err=%v", f.calls.Load(), err)
	}
	f.status.Store(http.StatusOK)
	if _, err := c.Introspect(ctx, "ak-good"); err != nil {
		t.Fatalf("recovered err = %v", err)
	}
}

func TestIntrospectSendsRawBasicCredentials(t *testing.T) {
	f := &fakeIdentity{answers: map[string]map[string]any{"ak-good": {"active": true, "sub": "u-1"}}}
	c, _ := newTestClient(t, f, testSecret)
	if _, err := c.Introspect(context.Background(), "ak-good"); err != nil {
		t.Fatalf("secret with +/= rejected: %v", err)
	}
	wrong, _ := newTestClient(t, f, "wrong")
	if _, err := wrong.Introspect(context.Background(), "ak-good"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("401 from identity err = %v", err)
	}
}

func TestIntrospectAcceptsOnlyKeysForThisService(t *testing.T) {
	exp := time.Unix(1000, 0).Add(time.Hour).Unix()
	cases := map[string]struct {
		answer map[string]any
		ok     bool
	}{
		"api key without audience":  {map[string]any{"active": true, "sub": "u", "token_type": "api_key"}, true},
		"aud string is ours":        {map[string]any{"active": true, "sub": "u", "aud": "agent-sandbox"}, true},
		"aud array contains ours":   {map[string]any{"active": true, "sub": "u", "aud": []string{"x", "agent-sandbox"}}, true},
		"client_id is ours":         {map[string]any{"active": true, "sub": "u", "client_id": "agent-sandbox"}, true},
		"aud is another service":    {map[string]any{"active": true, "sub": "u", "aud": "claw-brain", "exp": exp}, false},
		"client_id is another app":  {map[string]any{"active": true, "sub": "u", "client_id": "svc-other", "token_type": "access_token"}, false},
		"aud other, client_id ours": {map[string]any{"active": true, "sub": "u", "aud": "claw-brain", "client_id": "agent-sandbox"}, false},
		"delegated":                 {map[string]any{"active": true, "sub": "u", "act": map[string]any{"client_id": "svc-bot"}}, false},
		"no sub":                    {map[string]any{"active": true}, false},
		"already expired":           {map[string]any{"active": true, "sub": "u", "exp": 999}, false},
	}
	for name, tc := range cases {
		f := &fakeIdentity{answers: map[string]map[string]any{"ak": tc.answer}}
		c, _ := newTestClient(t, f, testSecret)
		_, err := c.Introspect(context.Background(), "ak")
		if tc.ok && err != nil {
			t.Errorf("%s: refused: %v", name, err)
		}
		if !tc.ok && !errors.Is(err, ErrInactive) {
			t.Errorf("%s: err = %v, want inactive", name, err)
		}
	}
}

func TestIntrospectCacheStopsAtExp(t *testing.T) {
	f := &fakeIdentity{answers: map[string]map[string]any{
		"ak": {"active": true, "sub": "u", "exp": time.Unix(1000, 0).Add(10 * time.Second).Unix()},
	}}
	c, now := newTestClient(t, f, testSecret)
	ctx := context.Background()
	if _, err := c.Introspect(ctx, "ak"); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(11 * time.Second)
	f.answers["ak"] = map[string]any{"active": false}
	if _, err := c.Introspect(ctx, "ak"); !errors.Is(err, ErrInactive) || f.calls.Load() != 2 {
		t.Fatalf("served past exp: calls=%d err=%v", f.calls.Load(), err)
	}
}

func TestIntrospectInvalidKeysDoNotEvictActiveOnes(t *testing.T) {
	f := &fakeIdentity{answers: map[string]map[string]any{"ak-good": {"active": true, "sub": "u"}}}
	c, _ := newTestClient(t, f, testSecret)
	ctx := context.Background()
	if _, err := c.Introspect(ctx, "ak-good"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxCacheSize+10; i++ {
		_, _ = c.Introspect(ctx, fmt.Sprintf("ak-random-%d", i))
	}
	before := f.calls.Load()
	if _, err := c.Introspect(ctx, "ak-good"); err != nil || f.calls.Load() != before {
		t.Fatalf("active entry evicted: calls %d -> %d err=%v", before, f.calls.Load(), err)
	}
}

func TestIntrospectCoalescesConcurrentLookups(t *testing.T) {
	f := &fakeIdentity{answers: map[string]map[string]any{"ak": {"active": true, "sub": "u"}}, gate: make(chan struct{})}
	c, _ := newTestClient(t, f, testSecret)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Introspect(context.Background(), "ak")
			errs <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(f.gate)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("identity calls = %d, want 1", n)
	}
}

func TestIntrospectUnreachableIsUnavailable(t *testing.T) {
	c := NewClient("http://127.0.0.1:1/oauth/introspect", "id", "secret", "")
	if _, err := c.Introspect(context.Background(), "ak-x"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
}
