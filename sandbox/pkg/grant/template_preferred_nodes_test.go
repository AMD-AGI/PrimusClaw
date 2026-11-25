// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

var preferredImage = `"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `"`

// A template's preferredNodes reach the CodeInterpreter of every expansion,
// in the flat and in the nested form.
func TestTemplatePreferredNodesRoundTrip(t *testing.T) {
	want := []string{"node-a", "node-b"}
	for name, spec := range map[string]string{
		"flat":   `{` + preferredImage + `,"preferredNodes":["node-a","node-b"]}`,
		"nested": `{"template":{` + preferredImage + `,"preferredNodes":["node-a","node-b"]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			templates := grantTemplate(spec)
			if err := validateTemplatePreferredNodes(templates, "invalid_grant"); err != nil {
				t.Fatal(err)
			}
			base, ok, err := templateFromSpec(spec)
			if err != nil || !ok {
				t.Fatalf("ok=%v err=%v", ok, err)
			}
			ci, err := codeInterpreter("grant", "ar-01ja-measurement-g1", base, 1, "ns")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(ci.Spec.Template.PreferredNodes, want) {
				t.Fatalf("preferredNodes=%v", ci.Spec.Template.PreferredNodes)
			}
			// The CodeInterpreter does not share the slice with the parsed spec.
			base.template.PreferredNodes[0] = "changed"
			if ci.Spec.Template.PreferredNodes[0] != "node-a" {
				t.Fatalf("preferredNodes shared with the spec: %v", ci.Spec.Template.PreferredNodes)
			}
		})
	}
}

func TestTemplatePreferredNodesRefused(t *testing.T) {
	cases := map[string]string{
		"not a node name": `{` + preferredImage + `,"preferredNodes":["Node_A"]}`,
		"twice":           `{` + preferredImage + `,"preferredNodes":["node-a","node-a"]}`,
		"nine":            `{` + preferredImage + `,"preferredNodes":["n1","n2","n3","n4","n5","n6","n7","n8","n9"]}`,
		"nested blank":    `{"template":{` + preferredImage + `,"preferredNodes":["node-a node-b"]}}`,
	}
	for name, spec := range cases {
		t.Run(name, func(t *testing.T) {
			err := validateTemplatePreferredNodes(grantTemplate(spec), "invalid_owner_policy")
			if !IsReason(err, "invalid_owner_policy") || !strings.Contains(err.Error(), "preferredNodes") {
				t.Fatalf("err=%v", err)
			}
			base, ok, err := templateFromSpec(spec)
			if err != nil || !ok {
				t.Fatalf("ok=%v err=%v", ok, err)
			}
			if _, err := codeInterpreter("grant", "ar-01ja-measurement-g1", base, 1, "ns"); err == nil {
				t.Fatal("codeInterpreter accepted the template")
			}
		})
	}
}

// Issue registers the template with its preferredNodes, and refuses a grant
// whose preferredNodes are invalid before any template is made.
func TestIssueCarriesPreferredNodes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Templates[0].Spec = json.RawMessage(`{` + preferredImage + `,"preferredNodes":["gpu-node-1"]}`)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ar-01ja-runner-g1", "ar-01ja-runner-g8"} {
		ci := &runtimev1alpha1.CodeInterpreter{}
		if err := svc.reader.Get(context.Background(), types.NamespacedName{Name: name, Namespace: svc.namespace}, ci); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(ci.Spec.Template.PreferredNodes, []string{"gpu-node-1"}) {
			t.Fatalf("%s preferredNodes=%v", name, ci.Spec.Template.PreferredNodes)
		}
	}

	svc, priv, _, _ = testService(t, now)
	req = sampleRequest(now.Add(time.Hour))
	req.Templates[0].Spec = json.RawMessage(`{` + preferredImage + `,"preferredNodes":["gpu-node-1","gpu-node-1"]}`)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); !IsReason(err, "invalid_grant") || !strings.Contains(err.Error(), "preferredNodes") {
		t.Fatalf("err=%v", err)
	}
	list := &runtimev1alpha1.CodeInterpreterList{}
	if err := svc.reader.List(context.Background(), list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 0 {
		t.Fatalf("templates made for a refused grant: %d", len(list.Items))
	}
}
