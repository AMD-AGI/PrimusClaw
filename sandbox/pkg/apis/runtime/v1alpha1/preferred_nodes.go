// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

// MaxPreferredNodes is the most names a template's preferredNodes may hold.
const MaxPreferredNodes = 8

// ValidatePreferredNodes checks a template's preferredNodes: at most
// MaxPreferredNodes names, each a DNS-1123 subdomain whose labels are DNS-1123
// labels of at most 63 characters (a node name), none twice.
func ValidatePreferredNodes(names []string) error {
	if len(names) > MaxPreferredNodes {
		return fmt.Errorf("preferredNodes has %d names, at most %d are allowed", len(names), MaxPreferredNodes)
	}
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
			return fmt.Errorf("preferredNodes name %q is not a node name: %s", name, errs[0])
		}
		for _, label := range strings.Split(name, ".") {
			if errs := validation.IsDNS1123Label(label); len(errs) > 0 {
				return fmt.Errorf("preferredNodes name %q is not a node name: %s", name, errs[0])
			}
		}
		if _, ok := seen[name]; ok {
			return fmt.Errorf("preferredNodes names %q twice", name)
		}
		seen[name] = struct{}{}
	}
	return nil
}
