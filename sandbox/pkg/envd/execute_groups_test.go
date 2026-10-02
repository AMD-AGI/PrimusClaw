// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
)

func TestOnlyTheProxyGroupIsLeftOut(t *testing.T) {
	cases := map[string]struct {
		groups []int
		want   []uint32
	}{
		"the pod's groups are kept": {
			groups: []int{1000, 2000, 3000},
			want:   []uint32{1000, 2000, 3000},
		},
		"the proxy group is dropped": {
			groups: []int{1000, egress.EnvDProxyGID, 2000},
			want:   []uint32{1000, 2000},
		},
		"no groups stay no groups": {
			groups: nil,
			want:   []uint32{},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := withoutEnvDProxyGroup(tc.groups); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("withoutEnvDProxyGroup(%v) = %v, want %v", tc.groups, got, tc.want)
			}
		})
	}
}

// A site account reaches its shared storage through the Pod's supplementary
// groups, so a command that loses them cannot write where the Pod can.
func TestACommandRunsWithThePodsGroupsButNotTheProxyGroup(t *testing.T) {
	requireJobShim(t)
	const siteGroup = 3000
	before, err := syscall.Getgroups()
	if err != nil {
		t.Fatalf("getgroups: %v", err)
	}
	if err := syscall.Setgroups([]int{siteGroup, egress.EnvDProxyGID}); err != nil {
		t.Skipf("cannot give this process the groups EnvD would have: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Setgroups(before) })

	code, out := run(t, newTestServer(), false, "id", "-G")
	if code != 0 {
		t.Fatalf("id -G exited %d: %s", code, out.String())
	}
	groups := strings.Fields(out.String())
	if !slices.Contains(groups, strconv.Itoa(siteGroup)) {
		t.Fatalf("the command lost the Pod's group %d: id -G = %v", siteGroup, groups)
	}
	if slices.Contains(groups, strconv.Itoa(egress.EnvDProxyGID)) {
		t.Fatalf("the command kept the proxy group %d: id -G = %v", egress.EnvDProxyGID, groups)
	}
}
