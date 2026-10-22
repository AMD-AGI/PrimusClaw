// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func TestCreateE2BSkipsInferenceKey(t *testing.T) {
	st := store.NewMemoryStore()
	srv := New(Config{Namespace: "ns", DefaultTTL: time.Hour}, st)
	res, err := srv.Create(context.Background(), e2b.CreateRequest{
		SandboxID: "sbx-1", TemplateID: "runner", Namespace: "ns",
		Timeout: time.Minute, UserID: "u-1", Env: map[string]string{"FOO": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.PodIP != "127.0.0.1" || res.SandboxName != "runner" {
		t.Fatalf("res=%+v", res)
	}
	info, err := st.GetSandboxBySessionID(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	if info.InferenceApiKey != "" || info.Status != "running" || info.UserID != "u-1" {
		t.Fatalf("info=%+v", info)
	}
	if err := srv.SetTimeout(context.Background(), "sbx-1", 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := srv.Delete(context.Background(), "sbx-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetSandboxBySessionID(context.Background(), "sbx-1"); err == nil {
		t.Fatal("session still present")
	}
}
