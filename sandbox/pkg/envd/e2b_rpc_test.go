// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestEnvDStartE2BCommand(t *testing.T) {
	requireJobShim(t)
	ws := t.TempDir()
	srv, err := New(Config{Workspace: ws})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(srv.Handler())
	defer front.Close()

	body := e2bStartTrue()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, front.URL+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("start %d %s", resp.StatusCode, payload)
	}
	if !bytes.Contains(payload, []byte{0x02}) {
		t.Fatalf("missing connect trailer %x", payload)
	}
}

// Through envd's own handler, the path a person gives files.write is the path
// commands.run sees, and a command given an absolute cwd runs in it. Both used
// to be mapped under the workspace: the upload went to <workspace>/tmp/x and a
// cwd of /tmp became <workspace>/tmp.
func TestEnvDE2BFilesAndCommandsShareAbsolutePaths(t *testing.T) {
	requireJobShim(t)
	ws := t.TempDir()
	other := t.TempDir()
	srv, err := New(Config{Workspace: ws})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(srv.Handler())
	defer front.Close()

	target := other + "/x"
	up, err := http.Post(front.URL+"/files?path="+target, "text/plain", bytes.NewReader([]byte("same-bytes-17")))
	if err != nil {
		t.Fatal(err)
	}
	upBody, _ := io.ReadAll(up.Body)
	_ = up.Body.Close()
	if up.StatusCode != http.StatusOK {
		t.Fatalf("upload %d %s", up.StatusCode, upBody)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "same-bytes-17" {
		t.Fatalf("file at %s: %q %v", target, got, err)
	}

	if out := e2bRun(t, front.URL, e2bStart("", "cat", target)); !bytes.Contains(out, []byte("same-bytes-17")) {
		t.Fatalf("cat %s did not read the upload: %q", target, out)
	}
	if out := e2bRun(t, front.URL, e2bStart(other, "pwd")); !bytes.Contains(out, []byte(other+"\n")) {
		t.Fatalf("pwd with cwd %s: %q", other, out)
	}
}

// e2bStart is a StartRequest for cmd args... in cwd (none when empty).
func e2bStart(cwd, cmd string, args ...string) []byte {
	cfg := appendProtoString(nil, 1, cmd)
	for _, a := range args {
		cfg = appendProtoString(cfg, 2, a)
	}
	if cwd != "" {
		cfg = appendProtoString(cfg, 4, cwd)
	}
	var b []byte
	b = appendProtoBytes(b, 1, cfg)
	return appendProtoVarint(b, 4, 0)
}

func e2bRun(t *testing.T, base string, body []byte) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("start %d %s", resp.StatusCode, payload)
	}
	return payload
}

func e2bStartTrue() []byte {
	// StartRequest{process:{cmd:"sh", args:["-c","true"]}, stdin:false}
	cfg := []byte{}
	cfg = appendProtoString(cfg, 1, "sh")
	cfg = appendProtoString(cfg, 2, "-c")
	cfg = appendProtoString(cfg, 2, "true")
	var b []byte
	b = appendProtoBytes(b, 1, cfg)
	b = appendProtoVarint(b, 4, 0)
	return b
}

func appendProtoString(b []byte, field byte, s string) []byte {
	b = append(b, field<<3|2, byte(len(s)))
	return append(b, s...)
}

func appendProtoBytes(b []byte, field byte, msg []byte) []byte {
	b = append(b, field<<3|2, byte(len(msg)))
	return append(b, msg...)
}

func appendProtoVarint(b []byte, field byte, v byte) []byte {
	return append(b, field<<3|0, v)
}
