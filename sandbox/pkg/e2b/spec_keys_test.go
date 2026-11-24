// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import "testing"

// A stored spec with two keys the decoder reads as workspace is refused, not
// read as the last of them.
func TestParseSpecRefusesFoldedDuplicateKeys(t *testing.T) {
	if _, err := parseSpec(`{"workspace":"W2","Workspace":"W1"}`); err == nil {
		t.Fatal("accepted")
	}
	body, err := parseSpec(`{"workspace":"W1","sealed":true}`)
	if err != nil || body.Workspace != "W1" || !body.Sealed {
		t.Fatalf("body=%+v err=%v", body, err)
	}
}
