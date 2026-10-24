// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import "k8s.io/apimachinery/pkg/runtime"

// DeepCopyInto copies the receiver into out.
func (in *SandboxGrant) DeepCopyInto(out *SandboxGrant) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

// DeepCopy returns a copy of the grant.
func (in *SandboxGrant) DeepCopy() *SandboxGrant {
	if in == nil {
		return nil
	}
	out := new(SandboxGrant)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject returns a copy as a runtime.Object.
func (in *SandboxGrant) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// DeepCopyInto copies the receiver into out.
func (in *SandboxGrantSpec) DeepCopyInto(out *SandboxGrantSpec) {
	*out = *in
	in.Owner.DeepCopyInto(&out.Owner)
	out.Issuer = in.Issuer
	if in.Roles != nil {
		out.Roles = make(map[string]GrantRole, len(in.Roles))
		for k, v := range in.Roles {
			out.Roles[k] = *v.DeepCopy()
		}
	}
	if in.Templates != nil {
		out.Templates = make([]GrantTemplate, len(in.Templates))
		for i := range in.Templates {
			in.Templates[i].DeepCopyInto(&out.Templates[i])
		}
	}
	in.ExpiresAt.DeepCopyInto(&out.ExpiresAt)
}

// DeepCopy returns a copy of the spec.
func (in *SandboxGrantSpec) DeepCopy() *SandboxGrantSpec {
	if in == nil {
		return nil
	}
	out := new(SandboxGrantSpec)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto copies the receiver into out.
func (in *GrantOwner) DeepCopyInto(out *GrantOwner) {
	*out = *in
	if in.Workspaces != nil {
		out.Workspaces = make([]string, len(in.Workspaces))
		copy(out.Workspaces, in.Workspaces)
	}
}

// DeepCopy returns a copy of the owner.
func (in *GrantOwner) DeepCopy() *GrantOwner {
	if in == nil {
		return nil
	}
	out := new(GrantOwner)
	in.DeepCopyInto(out)
	return out
}

// DeepCopy returns a copy of the role.
func (in *GrantRole) DeepCopy() *GrantRole {
	if in == nil {
		return nil
	}
	out := new(GrantRole)
	*out = *in
	if in.Templates != nil {
		out.Templates = make([]string, len(in.Templates))
		copy(out.Templates, in.Templates)
	}
	return out
}

// DeepCopyInto copies the receiver into out.
func (in *GrantTemplate) DeepCopyInto(out *GrantTemplate) {
	*out = *in
	if in.PerGPUCount != nil {
		out.PerGPUCount = make([]int32, len(in.PerGPUCount))
		copy(out.PerGPUCount, in.PerGPUCount)
	}
}

// DeepCopyInto copies the receiver into out.
func (in *SandboxGrantStatus) DeepCopyInto(out *SandboxGrantStatus) {
	*out = *in
	if in.KeyHashes != nil {
		out.KeyHashes = make(map[string]string, len(in.KeyHashes))
		for k, v := range in.KeyHashes {
			out.KeyHashes[k] = v
		}
	}
	if in.Usage != nil {
		out.Usage = make(map[string]GrantRoleUsage, len(in.Usage))
		for k, v := range in.Usage {
			out.Usage[k] = v
		}
	}
	if in.Sandboxes != nil {
		out.Sandboxes = make([]GrantSandboxRef, len(in.Sandboxes))
		for i := range in.Sandboxes {
			in.Sandboxes[i].DeepCopyInto(&out.Sandboxes[i])
		}
	}
}

// DeepCopy returns a copy of the status.
func (in *SandboxGrantStatus) DeepCopy() *SandboxGrantStatus {
	if in == nil {
		return nil
	}
	out := new(SandboxGrantStatus)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto copies the receiver into out.
func (in *GrantSandboxRef) DeepCopyInto(out *GrantSandboxRef) {
	*out = *in
	in.StartedAt.DeepCopyInto(&out.StartedAt)
	in.EndedAt.DeepCopyInto(&out.EndedAt)
	if in.Inputs != nil {
		out.Inputs = append([]string(nil), in.Inputs...)
	}
	if in.Outputs != nil {
		out.Outputs = append([]string(nil), in.Outputs...)
	}
	if in.Metadata != nil {
		out.Metadata = make(map[string]string, len(in.Metadata))
		for k, v := range in.Metadata {
			out.Metadata[k] = v
		}
	}
}

// DeepCopyInto copies the receiver into out.
func (in *SandboxGrantList) DeepCopyInto(out *SandboxGrantList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]SandboxGrant, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

// DeepCopy returns a copy of the list.
func (in *SandboxGrantList) DeepCopy() *SandboxGrantList {
	if in == nil {
		return nil
	}
	out := new(SandboxGrantList)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject returns a copy as a runtime.Object.
func (in *SandboxGrantList) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}
