// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package sandboxlayer validates template layers and renders them for a Pod.
// A layer is an image whose directory an init container copies into an
// emptyDir that the main container mounts.
package sandboxlayer

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"

	corev1 "k8s.io/api/core/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// Annotation carries the resolved layers on a SaFE Workload.
const Annotation = "agent-sandbox.io/layers"

// MaxLayers is the most layers one template may declare.
const MaxLayers = 4

// volumePrefix names the emptyDir of each layer.
const volumePrefix = "as-layer-"

// reservedPaths are owned by the sandbox runtime. A layer mount may not be
// one of them, sit under one, or contain one.
var reservedPaths = []string{
	"/app",
	"/bin",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/proc",
	"/run",
	"/sbin",
	"/shared",
	"/sys",
	"/tmp",
	"/usr",
	"/var/run",
}

var (
	digestImage = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$`)
	safePath    = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)
)

// Layer is a validated layer with readOnly resolved.
type Layer struct {
	Image    string `json:"image"`
	From     string `json:"from"`
	Mount    string `json:"mount"`
	ReadOnly bool   `json:"readOnly"`
}

// Validate checks layers against the digest, path, count, and overlap rules.
// taken lists mount paths the template already uses, such as host paths.
func Validate(layers []runtimev1alpha1.SandboxLayer, taken []string) error {
	_, err := Resolve(layers, taken)
	return err
}

// Resolve validates layers and returns them with readOnly defaulted to true.
func Resolve(layers []runtimev1alpha1.SandboxLayer, taken []string) ([]Layer, error) {
	if len(layers) == 0 {
		return nil, nil
	}
	if len(layers) > MaxLayers {
		return nil, fmt.Errorf("layers: at most %d layers, got %d", MaxLayers, len(layers))
	}
	out := make([]Layer, 0, len(layers))
	mounts := make([]string, 0, len(layers))
	for i, l := range layers {
		if !digestImage.MatchString(l.Image) {
			return nil, fmt.Errorf("layers[%d].image must be pinned by digest (name@sha256:<64 hex>)", i)
		}
		if err := checkPath(l.From); err != nil {
			return nil, fmt.Errorf("layers[%d].from: %w", i, err)
		}
		if err := checkPath(l.Mount); err != nil {
			return nil, fmt.Errorf("layers[%d].mount: %w", i, err)
		}
		for _, r := range reservedPaths {
			if overlaps(l.Mount, r) {
				return nil, fmt.Errorf("layers[%d].mount %s overlaps reserved path %s", i, l.Mount, r)
			}
		}
		for _, t := range taken {
			if t != "" && overlaps(l.Mount, path.Clean(t)) {
				return nil, fmt.Errorf("layers[%d].mount %s overlaps template mount %s", i, l.Mount, t)
			}
		}
		for _, m := range mounts {
			if overlaps(l.Mount, m) {
				return nil, fmt.Errorf("layers[%d].mount %s overlaps layer mount %s", i, l.Mount, m)
			}
		}
		mounts = append(mounts, l.Mount)
		readOnly := true
		if l.ReadOnly != nil {
			readOnly = *l.ReadOnly
		}
		out = append(out, Layer{Image: l.Image, From: l.From, Mount: l.Mount, ReadOnly: readOnly})
	}
	return out, nil
}

// TemplateMounts lists the mount paths a template already uses on the main container.
func TemplateMounts(tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate) []string {
	if tmpl == nil {
		return nil
	}
	var out []string
	for _, vm := range tmpl.VolumeMounts {
		out = append(out, vm.MountPath)
	}
	return out
}

// Encode returns the annotation value for resolved layers.
func Encode(layers []Layer) (string, error) {
	if len(layers) == 0 {
		return "", nil
	}
	raw, err := json.Marshal(layers)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// CopyCommand is the init container command that copies a layer into its mount.
func CopyCommand(l Layer) []string {
	return []string{"sh", "-c", "set -e; cp -a " + quote(l.From+"/.") + " " + quote(l.Mount+"/")}
}

// VolumeName is the emptyDir name of the layer at index i.
func VolumeName(i int) string {
	return fmt.Sprintf("%s%d", volumePrefix, i)
}

// PodParts returns the init containers, volumes, and main-container mounts for layers.
func PodParts(layers []Layer, pullPolicy corev1.PullPolicy) ([]corev1.Container, []corev1.Volume, []corev1.VolumeMount) {
	if pullPolicy == "" {
		pullPolicy = corev1.PullIfNotPresent
	}
	inits := make([]corev1.Container, 0, len(layers))
	volumes := make([]corev1.Volume, 0, len(layers))
	mounts := make([]corev1.VolumeMount, 0, len(layers))
	for i, l := range layers {
		name := VolumeName(i)
		volumes = append(volumes, corev1.Volume{Name: name, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}})
		inits = append(inits, corev1.Container{
			Name:            name,
			Image:           l.Image,
			ImagePullPolicy: pullPolicy,
			Command:         CopyCommand(l),
			VolumeMounts:    []corev1.VolumeMount{{Name: name, MountPath: l.Mount}},
		})
		mounts = append(mounts, corev1.VolumeMount{Name: name, MountPath: l.Mount, ReadOnly: l.ReadOnly})
	}
	return inits, volumes, mounts
}

// checkPath accepts a clean absolute path other than "/" with no shell metacharacters.
func checkPath(p string) error {
	if p == "" || p == "/" {
		return fmt.Errorf("must be an absolute path other than /")
	}
	if !safePath.MatchString(p) {
		return fmt.Errorf("%q must be absolute and use only letters, digits, '.', '_', '-', '/'", p)
	}
	if path.Clean(p) != p {
		return fmt.Errorf("%q must be a clean path", p)
	}
	return nil
}

// overlaps reports whether a equals b or one contains the other.
func overlaps(a, b string) bool {
	if a == b {
		return true
	}
	return strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

// quote wraps s in single quotes for sh.
func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
