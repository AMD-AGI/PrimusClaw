// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	"os"
	"regexp"
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
		{name: "label of 63", nodes: []string{strings.Repeat("a", 63) + ".example"}},
		{name: "label of 64", nodes: []string{strings.Repeat("a", 64)}, want: "not a node name"},
		{name: "inner label of 64", nodes: []string{"node." + strings.Repeat("a", 64) + ".example"}, want: "not a node name"},
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

// The CRD schema admits exactly the names ValidatePreferredNodes accepts, so a
// template written straight to the cluster cannot hold a name the Workload
// build refuses.
func TestPreferredNodesCRDPatternMatchesValidation(t *testing.T) {
	raw, err := os.ReadFile("../../../../deploy/crds/runtime/codeinterpreter-crd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	i := strings.Index(text, "preferredNodes:")
	if i < 0 {
		t.Fatal("preferredNodes is not in the CRD")
	}
	m := regexp.MustCompile(`pattern: '([^']+)'`).FindStringSubmatch(text[i:])
	if m == nil {
		t.Fatal("preferredNodes has no pattern in the CRD")
	}
	pattern := regexp.MustCompile(m[1])
	for _, name := range []string{
		"node-a", "gpu-node-1.example.internal", "a", "0", strings.Repeat("a", 63), strings.Repeat("a", 63) + "." + strings.Repeat("b", 63),
		strings.Repeat("a", 64), "node." + strings.Repeat("a", 64), "-node", "node-", "Node", "node_a", "node..a", ".node", "node.", "",
	} {
		crd := pattern.MatchString(name) && len(name) <= 253
		if valid := ValidatePreferredNodes([]string{name}) == nil; crd != valid {
			t.Errorf("%q: CRD admits=%v, validation accepts=%v", name, crd, valid)
		}
	}
}
