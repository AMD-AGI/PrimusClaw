// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"errors"
	"os"
	"os/exec"
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

func TestACredentialIsAskedForOnlyToLeaveTheProxyGroupOut(t *testing.T) {
	cases := map[string]struct {
		groups []int
		err    error
		want   *syscall.Credential
	}{
		"no proxy group: the child keeps EnvD's credential": {
			groups: []int{0, 65534},
			want:   nil,
		},
		"no groups: the child keeps EnvD's credential": {
			groups: nil,
			want:   nil,
		},
		"the proxy group is left out": {
			groups: []int{1000, egress.EnvDProxyGID},
			want:   &syscall.Credential{Uid: 7, Gid: 8, Groups: []uint32{1000}},
		},
		"unreadable groups narrow the child to its primary group": {
			groups: []int{1000, egress.EnvDProxyGID},
			err:    errors.New("getgroups failed"),
			want:   &syscall.Credential{Uid: 7, Gid: 8, Groups: []uint32{8}},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := childCredential(7, 8, tc.groups, tc.err); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("childCredential(7, 8, %v, %v) = %+v, want %+v", tc.groups, tc.err, got, tc.want)
			}
		})
	}
}

const insideDeniedSetgroupsEnv = "ENVD_TEST_INSIDE_DENIED_SETGROUPS"

// deniedSetgroups is a user namespace that maps root to this process's ids
// and denies setgroups(2), which is what apptainer --fakeroot gives a root
// container on a node whose account has no subuid range.
func deniedSetgroups() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Cloneflags:                 syscall.CLONE_NEWUSER,
		UidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
		GidMappingsEnableSetgroups: false,
	}
}

// A sandbox whose runtime denies setgroups must still run commands: before,
// every command there failed with "fork/exec /shared/bin/envd: operation not
// permitted" because the shim was started with a credential.
func TestACommandRunsWhereSetgroupsIsDenied(t *testing.T) {
	if os.Getenv(insideDeniedSetgroupsEnv) == "1" {
		state, err := os.ReadFile("/proc/self/setgroups")
		if err != nil || strings.TrimSpace(string(state)) != "deny" {
			t.Fatalf("not in a namespace that denies setgroups: %q, %v", state, err)
		}
		code, out := run(t, newTestServer(), false, "sh", "-c", "echo ran")
		if code != 0 || !strings.Contains(out.String(), "ran") {
			t.Fatalf("the command exited %d: %s", code, out.String())
		}
		return
	}
	probe := exec.Command("true")
	probe.SysProcAttr = deniedSetgroups()
	if err := probe.Run(); err != nil {
		t.Skipf("this environment cannot make a user namespace: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("executable: %v", err)
	}
	cmd := exec.Command(self, "-test.run=^TestACommandRunsWhereSetgroupsIsDenied$", "-test.count=1", "-test.v")
	cmd.Env = append(os.Environ(), insideDeniedSetgroupsEnv+"=1")
	cmd.SysProcAttr = deniedSetgroups()
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "--- PASS: TestACommandRunsWhereSetgroupsIsDenied") {
		t.Fatalf("inside a namespace that denies setgroups: %v\n%s", err, out)
	}
}
