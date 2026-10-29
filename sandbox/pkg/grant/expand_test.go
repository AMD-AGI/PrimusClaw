// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import "testing"

func TestExpandOneFoldsATaskIDIntoACodeInterpreterName(t *testing.T) {
	names := expandOne("ktsk_01M5YDCN3QHVTA7SGJQGS8Z3RY", TemplateRequest{Name: "dev"})
	if len(names) != 1 || names[0] != "ktsk-01m5ydcn3qhvta7sgjqgs8z3ry-dev" {
		t.Fatalf("got %v", names)
	}
	if !grantName.MatchString(names[0]) {
		t.Fatalf("%s is not a DNS-1123 label", names[0])
	}
}
