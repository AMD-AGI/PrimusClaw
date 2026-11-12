// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A command that leaves a detached child ends its Start stream with an end
// event when the command itself exits, whether or not the child keeps the
// output pipe.
func TestE2BStartEndsWhenCommandExits(t *testing.T) {
	requireJobShim(t)
	srv, err := New(Config{Workspace: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(srv.Handler())
	defer front.Close()
	defer func() {
		req, _ := http.NewRequest(http.MethodDelete, front.URL+"/api/jobs", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Errorf("purge jobs: %v", err)
			return
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("purge jobs: %d", resp.StatusCode)
		}
	}()
	for name, script := range map[string]string{
		"redirected": "echo started; sleep 15 </dev/null >/dev/null 2>&1 &",
		"inherited":  "echo started; setsid nohup sleep 15 &",
	} {
		t.Run(name, func(t *testing.T) {
			begin := time.Now()
			out := e2bRun(t, front.URL, e2bStart("", "sh", "-c", script))
			if took := time.Since(begin); took > 3*time.Second {
				t.Fatalf("stream ended after %s", took)
			}
			if !bytes.Contains(out, []byte("started")) || !bytes.Contains(out, []byte("exited")) {
				t.Fatalf("output %q", out)
			}
		})
	}
}
