// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"strings"
	"testing"
	"time"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// mountSpec is a template spec as an application platform renders a read-only
// host directory: a hostPath volume and a read-only mount at the same path, in
// a template without its workspace's storage.
const mountSpec = `{"fromImage":"example@sha256:` + "0000000000000000000000000000000000000000000000000000000000000000" + `","useWorkspaceStorage":false,
 "volumes":[{"name":"template-mount-0","hostPath":{"path":"/shared/team/cache","type":"Directory"}}],
 "volumeMounts":[{"name":"template-mount-0","mountPath":"/shared/team/cache","readOnly":true}]}`

func grantTemplate(spec string) []runtimev1alpha1.GrantTemplate {
	return []runtimev1alpha1.GrantTemplate{{Name: "measurement", Spec: spec, PerGPUCount: []int32{1}}}
}

// The registered template carries the host directory as a hostPath volume and
// a read-only mount at the same path, which the sandbox workload mounts.
func TestTemplateMountReachesTheTemplateReadOnly(t *testing.T) {
	templates := grantTemplate(mountSpec)
	if err := validateTemplateMounts(templates); err != nil {
		t.Fatal(err)
	}
	base, ok, err := templateFromSpec(templates[0].Spec)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	ci, err := codeInterpreter("grant", "ar-01ja-measurement-g1", base, 1, "ns")
	if err != nil {
		t.Fatal(err)
	}
	tmpl := ci.Spec.Template
	if len(tmpl.Volumes) != 1 || tmpl.Volumes[0].HostPath == nil || tmpl.Volumes[0].HostPath.Path != "/shared/team/cache" {
		t.Fatalf("volumes=%+v", tmpl.Volumes)
	}
	if len(tmpl.VolumeMounts) != 1 {
		t.Fatalf("volumeMounts=%+v", tmpl.VolumeMounts)
	}
	m := tmpl.VolumeMounts[0]
	if m.MountPath != "/shared/team/cache" || m.ReadOnly == nil || !*m.ReadOnly {
		t.Fatalf("mount=%+v readOnly=%v", m, m.ReadOnly)
	}
	if !tmpl.WorkspaceStorageOff() {
		t.Fatalf("useWorkspaceStorage=%v, want false on the registered template", tmpl.UseWorkspaceStorage)
	}
}

// A host directory is read-only only in a sandbox that does not also mount its
// workspace's storage, which is read-write and holds the directory: a template
// with a hostPath volume must turn the storage off, where Agent Sandbox reads
// the template (the nested template when it carries the image).
func TestTemplateMountsNeedTheWorkspaceStorageOff(t *testing.T) {
	img := `"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `"`
	vol := `"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c","readOnly":true}]`
	refused := map[string]string{
		"storage left out":        `{` + img + `,` + vol + `}`,
		"storage on":              `{` + img + `,"useWorkspaceStorage":true,` + vol + `}`,
		"off beside the template": `{"useWorkspaceStorage":false,"template":{` + img + `,` + vol + `}}`,
		"nested, storage on":      `{"template":{` + img + `,"useWorkspaceStorage":true,` + vol + `}}`,
	}
	for name, spec := range refused {
		err := validateTemplateMounts(grantTemplate(spec))
		if err == nil || !strings.Contains(err.Error(), "useWorkspaceStorage: false") {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	accepted := []string{
		`{` + img + `,"useWorkspaceStorage":false,` + vol + `}`,
		`{"template":{` + img + `,"useWorkspaceStorage":false,` + vol + `}}`,
		// Without host directories the storage is the template's own choice.
		`{` + img + `,"useWorkspaceStorage":true}`,
		`{` + img + `,"useWorkspaceStorage":false}`,
	}
	for _, spec := range accepted {
		if err := validateTemplateMounts(grantTemplate(spec)); err != nil {
			t.Errorf("%q: %v", spec, err)
		}
	}
}

// A grant template reaches a host path only as a read-only host directory at
// its own path; every other volume shape is refused before anything is made.
func TestTemplateMountsRefused(t *testing.T) {
	img := `"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `"`
	cases := map[string]string{
		"read-write":      `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c","readOnly":false}]}`,
		"other path":      `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/c","readOnly":true}]}`,
		"subPath":         `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared"}}],"volumeMounts":[{"name":"v","mountPath":"/shared","subPath":"c"}]}`,
		"dot-dot":         `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/../etc"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/../etc"}]}`,
		"root":            `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/"}}],"volumeMounts":[{"name":"v","mountPath":"/"}]}`,
		"relative":        `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"shared"}}],"volumeMounts":[{"name":"v","mountPath":"shared"}]}`,
		"colon":           `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/a:b"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/a:b"}]}`,
		"two sources":     `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"},"emptyDir":{}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		"case variant":    `{` + img + `,"Volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"VolumeMounts":[{"name":"v","mountPath":"/shared/c","readOnly":false}]}`,
		"unmounted":       `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}]}`,
		"unknown volume":  `{` + img + `,"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		"mounted twice":   `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"},{"name":"v","mountPath":"/shared/c"}]}`,
		"sidecar mount":   `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}],"sidecars":[{"name":"s","image":"i","volumeMounts":[{"name":"v","mountPath":"/w"}]}]}`,
		"system dir":      `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/etc/ssl"}}],"volumeMounts":[{"name":"v","mountPath":"/etc/ssl"}]}`,
		"above system":    `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/var"}}],"volumeMounts":[{"name":"v","mountPath":"/var"}]}`,
		"duplicate names": `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}},{"name":"v","hostPath":{"path":"/shared/d"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
	}
	for name, spec := range cases {
		if err := validateTemplateMounts(grantTemplate(spec)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An omitted readOnly is read-only (the template's default), a volume of
	// another source is not this check's, and neither is a template without
	// volumes or without an image.
	ok := []string{
		`{` + img + `,"useWorkspaceStorage":false,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		`{` + img + `,"volumes":[{"name":"s","emptyDir":{}}],"volumeMounts":[{"name":"s","mountPath":"/scratch","readOnly":false}],"sidecars":[{"name":"c","image":"i","volumeMounts":[{"name":"s","mountPath":"/scratch"}]}]}`,
		`{` + img + `,"volumes":[{"name":"c","configMap":{"name":"cfg"}}],"volumeMounts":[{"name":"c","mountPath":"/config"}]}`,
		`{` + img + `}`,
		``,
	}
	for _, spec := range ok {
		if err := validateTemplateMounts(grantTemplate(spec)); err != nil {
			t.Errorf("%q: %v", spec, err)
		}
	}
}

// A grant stored with a writable host directory (before its templates'
// volumes were checked) is not extended.
func TestExtendRefusesAStoredWritableHostMount(t *testing.T) {
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
	g.Spec.Templates[0].Spec = `{"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `",` +
		`"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c","readOnly":false}]}`
	if err := svc.client.Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Extend(context.Background(), req.GrantID, ExtendRequest{ExpiresAt: now.Add(2 * time.Hour), Attestation: req.Attestation})
	if !IsReason(err, "invalid_grant") || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("err=%v", err)
	}
}

// Keys the JSON decoder folds onto Agent Sandbox's (U+017F is s, U+212A is k)
// decode as those keys, and the decoded template is what is checked: the two
// probes of a hostPath volume spelt this way are refused, as is a writable
// mount of an allowed path reached the same way.
func TestTemplateMountsCheckTheDecodedTemplate(t *testing.T) {
	img := `"fromImage":"example@sha256:` + strings.Repeat("0", 64) + `"`
	cases := map[string]string{
		"volume\u017f":    `{` + img + `,"volume\u017f":[{"name":"a","hostPath":{"path":"/etc"}}],"volumeMounts":[{"name":"a","mountPath":"/etc"}]}`,
		"ho\u017ftPath":   `{` + img + `,"volumes":[{"name":"a","ho\u017ftPath":{"path":"/root"}}],"volumeMounts":[{"name":"a","mountPath":"/root"}]}`,
		"folded writable": `{` + img + `,"volumes":[{"name":"a","ho\u017ftPath":{"path":"/shared/c"}}],"volumeMount\u017f":[{"name":"a","mountPath":"/shared/c","readOnly":false}]}`,
		"nested":          `{"template":{` + img + `,"volumes":[{"name":"a","ho\u017ftPath":{"path":"/root"}}],"volumeMounts":[{"name":"a","mountPath":"/root"}]}}`,
	}
	for name, spec := range cases {
		base, ok, err := templateFromSpec(spec)
		if err != nil || !ok || len(base.template.Volumes) != 1 || base.template.Volumes[0].HostPath == nil {
			t.Fatalf("%s: the decoder did not fold the key onto hostPath: ok=%v err=%v", name, ok, err)
		}
		if err := validateTemplateMounts(grantTemplate(spec)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
