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

// countUserDescendants counts live descendants while excluding the Hands
// daemon itself. Descendants of Hands remain in the walk and are counted.
func countUserDescendants(shimPID int) (int, error) {
	procs, err := listProcs()
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
			if child.pid == shimPID {
				continue
			}
			if child.state == 'Z' || child.state == 'X' {
				continue
			}
			if strings.Contains(child.cmd, handsBinaryMark) {
				continue
			}
			count++
		}
	}
	return count, nil
}

// listProcs snapshots process identity and parent links from procfs.
func listProcs() ([]procInfo, error) {
	ents, err := os.ReadDir("/proc")
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
		p, ok := readProc(pid)
		if ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// readProc reads one process, tolerating normal exit races.
func readProc(pid int) (procInfo, bool) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
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
	if c, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil && len(c) > 0 {
		cmd = string(bytes.ReplaceAll(c, []byte{0}, []byte{' '}))
	}
	return procInfo{pid: pid, ppid: ppid, state: fields[0][0], cmd: cmd}, true
}
