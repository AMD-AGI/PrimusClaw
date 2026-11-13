// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/envd/e2b/envdversion"
)

// The control plane reports envdversion.Version, so the SDK uses every feature
// gated at or below it. These are the ones EnvD itself has to serve, sent the
// way the SDK sends them.

// 0.5.2: close_stdin. The SDK's sync and async clients use the JSON codec.
func TestCloseStdinAsTheSDKSendsItEndsTheCommand(t *testing.T) {
	if envdversion.Version != "0.5.2" {
		t.Fatalf("gate set changed: Version=%s; extend this test with the new gates", envdversion.Version)
	}
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	on := true
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start",
		bytes.NewReader(protoStartStdin("cat", &on)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	first, err := readEvent(resp.Body)
	if err != nil || !first.start || first.pid == 0 {
		t.Fatalf("start %#v %v", first, err)
	}
	sent := postRaw(t, srv.URL+"/process.Process/SendInput", "application/proto", protoInput(first.pid, []byte("hello-793\n")))
	_ = sent.Body.Close()
	if sent.StatusCode != http.StatusOK {
		t.Fatalf("send %d", sent.StatusCode)
	}
	closed := postRaw(t, srv.URL+"/process.Process/CloseStdin", "application/json",
		[]byte(fmt.Sprintf(`{"process":{"pid":%d}}`, first.pid)))
	cb, _ := io.ReadAll(closed.Body)
	_ = closed.Body.Close()
	if closed.StatusCode != http.StatusOK {
		t.Fatalf("close_stdin %d %s", closed.StatusCode, cb)
	}
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	ended, code := false, -1
	for _, ev := range events {
		if !ev.err {
			out.Write(ev.data)
		}
		if ev.end {
			ended, code = true, ev.code
		}
	}
	if !ended || code != 0 || out.String() != "hello-793\n" {
		t.Fatalf("out=%q code=%d ended=%v", out.String(), code, ended)
	}
	if ctx.Err() != nil {
		t.Fatal("cat did not end before the deadline")
	}
	list := postRaw(t, srv.URL+"/process.Process/List", "application/json", []byte(`{}`))
	lb, _ := io.ReadAll(list.Body)
	_ = list.Body.Close()
	if strings.Contains(string(lb), fmt.Sprintf(`"pid":%d`, first.pid)) {
		t.Fatalf("ended command still listed: %s", lb)
	}
}

// 0.3.0: the SDK may now send stdin=false. The command starts with stdin
// closed: it reads EOF at once and input to it is refused.
func TestStdinFalseStartsWithStdinClosed(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	off := false
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start",
		bytes.NewReader(protoStartStdin("sh", &off, "-c", `cat; echo eof; sleep 2`)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	first, err := readEvent(resp.Body)
	if err != nil || !first.start {
		t.Fatalf("start %#v %v", first, err)
	}
	sent := postRaw(t, srv.URL+"/process.Process/SendInput", "application/proto", protoInput(first.pid, []byte("x")))
	_ = sent.Body.Close()
	if sent.StatusCode == http.StatusOK {
		t.Fatal("input accepted for a command started with stdin=false")
	}
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	ended := false
	for _, ev := range events {
		if !ev.err {
			out.Write(ev.data)
		}
		ended = ended || ev.end
	}
	if !ended || out.String() != "eof\n" {
		t.Fatalf("out=%q ended=%v", out.String(), ended)
	}
}

// 0.4.0: the SDK stops sending the default user. A request with no user and one
// with the old Basic "user:" header run the same command the same way.
func TestNoDefaultUserRunsLikeTheOldDefault(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	run := func(headers map[string]string) string {
		resp := postHeader(t, srv.URL+"/process.Process/Start", "application/proto", protoStart("id", "-u"), headers)
		defer resp.Body.Close()
		events, err := readEvents(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		var out strings.Builder
		for _, ev := range events {
			if !ev.err {
				out.Write(ev.data)
			}
		}
		return out.String()
	}
	withUser := run(map[string]string{"Authorization": "Basic dXNlcjo="})
	without := run(nil)
	if withUser == "" || withUser != without {
		t.Fatalf("with user %q, without %q", withUser, without)
	}

	path := ws + "/u.txt"
	for _, q := range []string{"&username=user", ""} {
		w := postRaw(t, srv.URL+"/files?path="+path+q, "text/plain", []byte("v"+q))
		_ = w.Body.Close()
		if w.StatusCode != http.StatusOK {
			t.Fatalf("write%s %d", q, w.StatusCode)
		}
		if got := getRaw(t, srv.URL+"/files?path="+path+q); got != "v"+q {
			t.Fatalf("read%s %q", q, got)
		}
	}
}
