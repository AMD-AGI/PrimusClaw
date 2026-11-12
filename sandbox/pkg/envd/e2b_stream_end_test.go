// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"bytes"
	"net/http/httptest"
	"testing"
	"time"
)

// A command that leaves a detached child ends its Start stream when the
// command itself exits, whether or not the child keeps the output pipe.
func TestE2BStartEndsWhenCommandExits(t *testing.T) {
	requireJobShim(t)
	srv, err := New(Config{Workspace: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(srv.Handler())
	defer front.Close()
	for name, script := range map[string]string{
		"redirected": "echo started; sleep 15 </dev/null >/dev/null 2>&1 &",
		"inherited":  "echo started; setsid nohup sleep 15 &",
	} {
		t.Run(name, func(t *testing.T) {
			begin := time.Now()
			out := e2bRun(t, front.URL, e2bStart("", "sh", "-c", script))
			if took := time.Since(begin); took > 5*time.Second {
				t.Fatalf("stream ended after %s", took)
			}
			if !bytes.Contains(out, []byte("started")) {
				t.Fatalf("output %q", out)
			}
		})
	}
}
