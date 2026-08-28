// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package predicates

import (
	"fmt"

	"sigs.k8s.io/controller-runtime/pkg/client"
)

// ObjectPredicate is a function that evaluates a predicate against a client.Object.
// When the predicate matches, it returns true.
// If there is an error during evaluation, it returns an error.
type ObjectPredicate interface {
	// Matches evaluates the predicate against the given object.
	// Returns true if the predicate matches, false if it does not match, or an error if there was an issue evaluating the predicate.
	Matches(obj client.Object) (bool, error)

	// fmt.Stringer enforces that we have string representation of the predicate for logging and debugging purposes.
	fmt.Stringer
}
