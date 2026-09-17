// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"os"
	"strconv"
	"strings"
)

type procInfo struct {
	pid   int
	ppid  int
	state byte
	cmd   string
}

// The process table this walk reads.
const procRoot = "/proc"

// countUserDescendants counts live descendants while excluding the Hands
// daemon itself. Descendants of Hands remain in the walk and are counted.
func countUserDescendants(shimPID int) (int, error) {
	return countUserDescendantsIn(procRoot, shimPID)
}

// countUserDescendantsIn is the walk itself, over a given process table. The
// table is a parameter because its size decides the cost: a sandbox holds a few
// dozen processes, while a build host can hold hundreds of thousands, and a
// test that walked the latter would measure the host rather than the tree.
func countUserDescendantsIn(root string, shimPID int) (int, error) {
	procs, err := listProcs(root)
	if err != nil {
		return 0, err
	}
	byPPID := make(map[int][]procInfo)
	for _, p := range procs {
		byPPID[p.ppid] = append(byPPID[p.ppid], p)
	}
	seen := map[int]bool{shimPID: true}
	queue := []int{shimPID}
	count := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, child := range byPPID[cur] {
			if seen[child.pid] {
				continue
			}
			seen[child.pid] = true
			queue = append(queue, child.pid)
			if child.state == 'Z' || child.state == 'X' {
				continue
			}
			if isHandsProcess(child.cmd) {
				continue
			}
			count++
		}
	}
	return count, nil
}

// isHandsProcess reports whether a process is the Hands daemon itself.
//
// Matched on the basename of argv[0], not on the command line containing the
// name somewhere: a user command that merely mentions the path -- copying it,
// listing it, naming a wrapper after it -- is user work, and excluding it would
// report an occupied sandbox as idle. Hands is deployed under more than one
// path, so the leading directories are not part of the test.
func isHandsProcess(cmd string) bool {
	argv0 := cmd
	if i := strings.IndexByte(argv0, ' '); i >= 0 {
		argv0 = argv0[:i]
	}
	if i := strings.LastIndexByte(argv0, '/'); i >= 0 {
		argv0 = argv0[i+1:]
	}
	return argv0 == handsBinaryMark || argv0 == "."+handsBinaryMark
}

// listProcs snapshots process identity and parent links from procfs.
func listProcs(root string) ([]procInfo, error) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []procInfo
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		p, ok := readProc(root, pid)
		if ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// readProc reads one process, tolerating normal exit races.
func readProc(root string, pid int) (procInfo, bool) {
	raw, err := os.ReadFile(root + "/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return procInfo{}, false
	}
	lparen := bytes.IndexByte(raw, '(')
	rparen := bytes.LastIndexByte(raw, ')')
	if lparen < 0 || rparen <= lparen || rparen+2 >= len(raw) {
		return procInfo{}, false
	}
	rest := strings.TrimSpace(string(raw[rparen+1:]))
	fields := strings.Fields(rest)
	if len(fields) < 2 {
		return procInfo{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return procInfo{}, false
	}
	cmd := string(raw[lparen+1 : rparen])
	if c, err := os.ReadFile(root + "/" + strconv.Itoa(pid) + "/cmdline"); err == nil && len(c) > 0 {
		cmd = string(bytes.ReplaceAll(c, []byte{0}, []byte{' '}))
	}
	return procInfo{pid: pid, ppid: ppid, state: fields[0][0], cmd: cmd}, true
}
