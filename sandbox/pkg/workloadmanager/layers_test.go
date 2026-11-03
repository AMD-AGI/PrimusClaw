// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"testing"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

const testLayerImage = "registry.example/layer@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestBuildPodTemplateRendersLayers(t *testing.T) {
	ci := extraCATestCI()
	ci.Spec.Template.Layers = []runtimev1alpha1.SandboxLayer{{Image: testLayerImage, From: "/layer", Mount: "/opt/host"}}
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(ci)

	inits := pt.Spec.InitContainers
	if len(inits) != 2 || inits[0].Name != "envd-injector" || inits[1].Name != "as-layer-0" || inits[1].Image != testLayerImage {
		t.Fatalf("init containers = %+v", inits)
	}
	found := false
	for _, vm := range pt.Spec.Containers[0].VolumeMounts {
		if vm.Name == "as-layer-0" {
			found = vm.MountPath == "/opt/host" && vm.ReadOnly
		}
	}
	if !found {
		t.Fatalf("main mounts = %+v", pt.Spec.Containers[0].VolumeMounts)
	}
	volume := false
	for _, v := range pt.Spec.Volumes {
		if v.Name == "as-layer-0" && v.EmptyDir != nil {
			volume = true
		}
	}
	if !volume {
		t.Fatalf("volumes = %+v", pt.Spec.Volumes)
	}
}

func TestValidateTemplateLayers(t *testing.T) {
	ci := extraCATestCI()
	ci.Spec.Template.Layers = []runtimev1alpha1.SandboxLayer{{Image: testLayerImage, From: "/layer", Mount: "/opt/host"}}
	if err := validateTemplateLayers(ci.Spec); err != nil {
		t.Fatal(err)
	}
	ci.Spec.Template.Layers[0].Image = "registry.example/layer:latest"
	if err := validateTemplateLayers(ci.Spec); err == nil {
		t.Fatal("tag image must be rejected")
	}
}
