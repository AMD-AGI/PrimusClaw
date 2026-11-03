// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestEnsureRouterPublicKeyCreatesAndUpdates(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset()
	for _, key := range []string{"key-1", "key-1", "key-2"} {
		if err := ensureRouterPublicKey(ctx, cs, "ws-a", key); err != nil {
			t.Fatal(err)
		}
		cm, err := cs.CoreV1().ConfigMaps("ws-a").Get(ctx, RouterPublicKeyConfigMap, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if cm.Data[PublicKeyDataKey] != key {
			t.Fatalf("data = %v, want %s", cm.Data, key)
		}
	}
}
