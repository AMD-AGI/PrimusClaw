// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	runtime "k8s.io/apimachinery/pkg/runtime"
)

// DeepCopyInto copies the receiver into out.
func (in *SandboxPolicy) DeepCopyInto(out *SandboxPolicy) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
}

// DeepCopy creates a new SandboxPolicy.
func (in *SandboxPolicy) DeepCopy() *SandboxPolicy {
	if in == nil {
		return nil
	}
	out := new(SandboxPolicy)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject implements runtime.Object.
func (in *SandboxPolicy) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// DeepCopyInto copies the receiver into out.
func (in *SandboxPolicyList) DeepCopyInto(out *SandboxPolicyList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		in, out := &in.Items, &out.Items
		*out = make([]SandboxPolicy, len(*in))
		for i := range *in {
			(*in)[i].DeepCopyInto(&(*out)[i])
		}
	}
}

// DeepCopy creates a new SandboxPolicyList.
func (in *SandboxPolicyList) DeepCopy() *SandboxPolicyList {
	if in == nil {
		return nil
	}
	out := new(SandboxPolicyList)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject implements runtime.Object.
func (in *SandboxPolicyList) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// DeepCopyInto copies the receiver into out.
func (in *SandboxPolicySpec) DeepCopyInto(out *SandboxPolicySpec) {
	*out = *in
	if in.AllowedEgressHosts != nil {
		in, out := &in.AllowedEgressHosts, &out.AllowedEgressHosts
		*out = make([]string, len(*in))
		copy(*out, *in)
	}
	if in.AllowedInternalHosts != nil {
		in, out := &in.AllowedInternalHosts, &out.AllowedInternalHosts
		*out = make([]string, len(*in))
		copy(*out, *in)
	}
}

// DeepCopy creates a new SandboxPolicySpec.
func (in *SandboxPolicySpec) DeepCopy() *SandboxPolicySpec {
	if in == nil {
		return nil
	}
	out := new(SandboxPolicySpec)
	in.DeepCopyInto(out)
	return out
}
