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
