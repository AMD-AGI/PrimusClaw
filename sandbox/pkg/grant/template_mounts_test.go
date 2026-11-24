// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"strings"
	"testing"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// mountSpec is a template spec as an application platform renders a read-only
// host directory: a hostPath volume and a read-only mount at the same path.
const mountSpec = `{"fromImage":"example@sha256:` + "0000000000000000000000000000000000000000000000000000000000000000" + `",
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
		"nfs":             `{` + img + `,"volumes":[{"name":"v","nfs":{"server":"nfs.example.invalid","path":"/"}}],"volumeMounts":[{"name":"v","mountPath":"/n"}]}`,
		"case variant":    `{` + img + `,"Volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"VolumeMounts":[{"name":"v","mountPath":"/shared/c","readOnly":false}]}`,
		"two sources":     `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"},"emptyDir":{}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		"unmounted":       `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}]}`,
		"unknown volume":  `{` + img + `,"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		"mounted twice":   `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"},{"name":"v","mountPath":"/shared/c"}]}`,
		"sidecar mount":   `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}],"sidecars":[{"name":"s","image":"i","volumeMounts":[{"name":"v","mountPath":"/w"}]}]}`,
		"duplicate names": `{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}},{"name":"v","hostPath":{"path":"/shared/d"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
	}
	for name, spec := range cases {
		if err := validateTemplateMounts(grantTemplate(spec)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An omitted readOnly is read-only (the template's default), an emptyDir
	// is the template's own to mount as it likes, and a template without
	// volumes, or without an image, is not this check's.
	ok := []string{
		`{` + img + `,"volumes":[{"name":"v","hostPath":{"path":"/shared/c"}}],"volumeMounts":[{"name":"v","mountPath":"/shared/c"}]}`,
		`{` + img + `,"volumes":[{"name":"s","emptyDir":{}}],"volumeMounts":[{"name":"s","mountPath":"/scratch","readOnly":false}],"sidecars":[{"name":"c","image":"i","volumeMounts":[{"name":"s","mountPath":"/scratch"}]}]}`,
		`{` + img + `}`,
		``,
	}
	for _, spec := range ok {
		if err := validateTemplateMounts(grantTemplate(spec)); err != nil {
			t.Errorf("%q: %v", spec, err)
		}
	}
}
