// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The decoder keeps the last of two keys it matches to one field, so a spec
// with both is refused before anything decodes it: a reader of the exact key
// and the decoder would otherwise disagree.
func TestCheckSpecKeysRefusesFoldedDuplicates(t *testing.T) {
	img := `"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `"`
	probe := `{"name":"m",` + img + `,"workspace":"W2","Workspace":"W1"}`
	var body struct {
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal([]byte(probe), &body); err != nil || body.Workspace != "W1" {
		t.Fatalf("decoder read workspace=%q err=%v; the probe no longer shows the mismatch", body.Workspace, err)
	}
	cases := map[string]string{
		"workspace":       probe,
		"nested template": `{"template":{` + img + `,"volumes":[],"Volumes":[{"name":"a","hostPath":{"path":"/root"}}]}}`,
		"template twice":  `{"template":{` + img + `},"Template":{` + img + `}}`,
		"in an array":     `{` + img + `,"volumes":[{"name":"a","emptyDir":{},"Name":"b"}]}`,
		"non-ASCII fold":  `{` + img + `,"volumes":[],"volumeſ":[{"name":"a","hostPath":{"path":"/etc"}}]}`,
		"kelvin fold":     `{` + img + `,"workspace":"W2","worKspace":"W1"}`,
		"exact duplicate": `{` + img + `,"workspace":"W2","workspace":"W1"}`,
		"trailing value":  `{` + img + `} {}`,
		"not JSON":        `{` + img,
	}
	for name, spec := range cases {
		if err := CheckSpecKeys(spec); err == nil {
			t.Errorf("%s: accepted", name)
		}
		if err := validateSpecKeys(grantTemplate(spec), "invalid_grant"); !IsReason(err, "invalid_grant") {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	// Keys the decoder keeps apart are not refused: dotless ı is not i.
	if err := CheckSpecKeys(`{"labels":{"\u0131d":"a","Id":"b"}}`); err != nil {
		t.Errorf("dotless i: %v", err)
	}
	ok := []string{
		``,
		mountSpec,
		`{"template":{` + img + `,"workspace":"W1"},"workspace":"W1","gpu":{"sharedMemory":"1Gi"}}`,
		`{"env":[{"name":"A"},{"name":"B"}],"labels":{"a":"x","b":"y"}}`,
	}
	for _, spec := range ok {
		if err := CheckSpecKeys(spec); err != nil {
			t.Errorf("%q: %v", spec, err)
		}
	}
}

// Issue refuses the reviewer's probe as an invalid grant, before any template is made.
func TestIssueRefusesFoldedDuplicateKeys(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Templates[0].Spec = json.RawMessage(`{"workspace":"W2","Workspace":"W1"}`)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); !IsReason(err, "invalid_grant") || !strings.Contains(err.Error(), "Workspace") {
		t.Fatalf("err=%v", err)
	}
}

// A grant stored with such a spec (before the keys were checked) is not extended.
func TestExtendRefusesAStoredFoldedDuplicate(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	g, err := svc.get(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	g.Spec.Templates[0].Spec = `{"workspace":"W2","Workspace":"W1"}`
	if err := svc.client.Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Extend(context.Background(), req.GrantID, ExtendRequest{ExpiresAt: now.Add(2 * time.Hour), Attestation: req.Attestation})
	if !IsReason(err, "invalid_grant") {
		t.Fatalf("err=%v", err)
	}
}
