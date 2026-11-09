// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"fmt"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// What SaFE's workload webhook admits on one MI355X node, written out from the
// live NodeFlavors rather than derived from the per-card constants:
//   - vk-mi355x (the crusoe-spur-vk workspace): 236 CPU, 2Ti memory. With
//     cpu_reserve_percent 0.07 and mem_reserve_percent 0.05 SaFE admits
//     236-ceil(16.52)=219 CPU and 2089072092774 bytes of memory, the
//     max.available it printed when it refused the g8 measurement template.
//   - amd-mi355x-example (crusoe): 3320629005Ki ephemeral storage, of which
//     max_ephemeral_store_percent 0.6 may go to one workload. This is the smaller
//     of the two flavors' storage limits.
var (
	mi355xAdmittedCPU     = resource.MustParse("219")
	mi355xAdmittedMemory  = *resource.NewQuantity(2089072092774, resource.BinarySI)
	mi355xAdmittedStorage = *resource.NewQuantity(int64(float64(3320629005*1024)*0.6), resource.BinarySI)
	mi355xCards           = int32(8)
)

func measurementTemplateForCards(t *testing.T, gpus int32) *runtimev1alpha1.CodeInterpreter {
	t.Helper()
	base := &runtimev1alpha1.CodeInterpreterSandboxTemplate{FromImage: "example@sha256:" + fmt.Sprintf("%064d", 0)}
	return codeInterpreter("grant", fmt.Sprintf("ar-01ja-measurement-g%d", gpus), base, gpus, "ns")
}

// Every card count up to a whole node is admitted on one MI355X node, and as
// many sandboxes of that size as the node has cards for fit the node together.
// The g8 template asked for 2048Gi before, which SaFE refused.
func TestGPUTemplatesFitOneMI355XNode(t *testing.T) {
	for gpus := int32(1); gpus <= mi355xCards; gpus++ {
		ci := measurementTemplateForCards(t, gpus)
		for kind, list := range map[string]corev1.ResourceList{"requests": ci.Spec.Template.Resources.Requests, "limits": ci.Spec.Template.Resources.Limits} {
			for name, admitted := range map[corev1.ResourceName]resource.Quantity{
				corev1.ResourceCPU:              mi355xAdmittedCPU,
				corev1.ResourceMemory:           mi355xAdmittedMemory,
				corev1.ResourceEphemeralStorage: mi355xAdmittedStorage,
			} {
				got, ok := list[name]
				if !ok {
					t.Fatalf("g%d %s has no %s", gpus, kind, name)
				}
				if got.Cmp(admitted) > 0 {
					t.Errorf("g%d %s %s=%s exceeds the %s SaFE admits on one MI355X node", gpus, kind, name, got.String(), admitted.String())
				}
				if mi355xCards/gpus < 2 {
					continue
				}
				together := got.DeepCopy()
				together.Mul(int64(mi355xCards / gpus))
				if together.Cmp(admitted) > 0 {
					t.Errorf("%d g%d sandboxes need %s %s, more than one MI355X node's %s", mi355xCards/gpus, gpus, together.String(), name, admitted.String())
				}
			}
		}
		if ci.Spec.GPU == nil || ci.Spec.GPU.Count != int(gpus) {
			t.Fatalf("g%d gpu=%+v", gpus, ci.Spec.GPU)
		}
		shm := resource.MustParse(ci.Spec.GPU.SharedMemory)
		memory := ci.Spec.Template.Resources.Limits[corev1.ResourceMemory]
		if shm.Cmp(memory) > 0 {
			t.Errorf("g%d shared memory %s exceeds the pod memory limit %s", gpus, shm.String(), memory.String())
		}
	}
}
