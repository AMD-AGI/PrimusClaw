// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package sandboxlayer

import (
	"strings"
	"testing"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

const testImage = "registry.example/layer@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func layer(from, mount string) runtimev1alpha1.SandboxLayer {
	return runtimev1alpha1.SandboxLayer{Image: testImage, From: from, Mount: mount}
}

func TestResolveDefaultsReadOnly(t *testing.T) {
	rw := false
	got, err := Resolve([]runtimev1alpha1.SandboxLayer{
		layer("/layer", "/opt/host"),
		{Image: testImage, From: "/data", Mount: "/opt/data", ReadOnly: &rw},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !got[0].ReadOnly || got[1].ReadOnly {
		t.Fatalf("readOnly = %v, %v", got[0].ReadOnly, got[1].ReadOnly)
	}
	enc, err := Encode(got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(enc, `"readOnly":true`) || !strings.Contains(enc, `"mount":"/opt/data"`) {
		t.Fatalf("encode = %s", enc)
	}
}

func TestResolveRejects(t *testing.T) {
	cases := map[string]struct {
		layers []runtimev1alpha1.SandboxLayer
		taken  []string
	}{
		"tag image":      {layers: []runtimev1alpha1.SandboxLayer{{Image: "registry.example/layer:v1", From: "/a", Mount: "/opt/a"}}},
		"short digest":   {layers: []runtimev1alpha1.SandboxLayer{{Image: "registry.example/layer@sha256:abc", From: "/a", Mount: "/opt/a"}}},
		"relative from":  {layers: []runtimev1alpha1.SandboxLayer{layer("a", "/opt/a")}},
		"root mount":     {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/")}},
		"unclean mount":  {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/opt/../etc")}},
		"shell mount":    {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/opt/a;rm")}},
		"reserved":       {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/app/tool")}},
		"reserved child": {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/var")}},
		"signing key":    {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/run/signing-key")}},
		"taken":          {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/data/x")}, taken: []string{"/data"}},
		"nested layers":  {layers: []runtimev1alpha1.SandboxLayer{layer("/a", "/opt/a"), layer("/b", "/opt/a/b")}},
		"too many": {layers: []runtimev1alpha1.SandboxLayer{
			layer("/a", "/opt/a"), layer("/a", "/opt/b"), layer("/a", "/opt/c"), layer("/a", "/opt/d"), layer("/a", "/opt/e"),
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Resolve(tc.layers, tc.taken); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestPodParts(t *testing.T) {
	got, err := Resolve([]runtimev1alpha1.SandboxLayer{layer("/layer", "/opt/host")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	inits, vols, mounts := PodParts(got, "")
	if len(inits) != 1 || len(vols) != 1 || len(mounts) != 1 {
		t.Fatalf("parts = %d %d %d", len(inits), len(vols), len(mounts))
	}
	if inits[0].Name != "as-layer-0" || vols[0].EmptyDir == nil || !mounts[0].ReadOnly || mounts[0].MountPath != "/opt/host" {
		t.Fatalf("unexpected parts %+v %+v %+v", inits[0], vols[0], mounts[0])
	}
	if cmd := inits[0].Command[2]; cmd != "set -e; cp -a '/layer/.' '/opt/host/'" {
		t.Fatalf("command = %s", cmd)
	}
}
