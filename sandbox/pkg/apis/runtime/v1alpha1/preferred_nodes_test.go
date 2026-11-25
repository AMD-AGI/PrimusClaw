// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	"strings"
	"testing"
)

func TestValidatePreferredNodes(t *testing.T) {
	cases := []struct {
		name  string
		nodes []string
		want  string
	}{
		{name: "none"},
		{name: "names", nodes: []string{"gpu-node-1", "node-b.example.internal"}},
		{name: "eight", nodes: []string{"n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"}},
		{name: "nine", nodes: []string{"n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"}, want: "at most 8"},
		{name: "twice", nodes: []string{"node-a", "node-b", "node-a"}, want: `"node-a" twice`},
		{name: "upper case", nodes: []string{"Node-A"}, want: "not a node name"},
		{name: "blank", nodes: []string{"node-a node-b"}, want: "not a node name"},
		{name: "empty", nodes: []string{""}, want: "not a node name"},
		{name: "underscore", nodes: []string{"node_a"}, want: "not a node name"},
		{name: "too long", nodes: []string{strings.Repeat("a", 254)}, want: "not a node name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePreferredNodes(tc.nodes)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err=%v, want %q", err, tc.want)
			}
		})
	}
}

func TestPreferredNodesDeepCopy(t *testing.T) {
	in := &CodeInterpreterSandboxTemplate{FromImage: "example", PreferredNodes: []string{"node-a"}}
	out := &CodeInterpreterSandboxTemplate{}
	in.DeepCopyInto(out)
	out.PreferredNodes[0] = "node-b"
	if in.PreferredNodes[0] != "node-a" {
		t.Fatalf("deep copy shares preferredNodes: %v", in.PreferredNodes)
	}
}
