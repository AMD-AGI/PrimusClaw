// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// The main container used to carry PATH as a pod-spec env var, which replaces
// the image's PATH, and every command envd starts inherited that replacement:
// an image's venv, toolchain and sbin directories were missing from the
// sandbox while every other variable the image declares came through. These
// tests run the main container's real startup command, as the pod template
// carries it, under every POSIX shell on the host and pin that
//
//   - the PATH the container starts with comes first, in its own order;
//   - every entry the old PATH had follows it, once, so nothing that resolved
//     before stops resolving;
//   - an empty PATH gets exactly the old value;
//   - the startup reaches its build steps (and the extra-CA check runs its
//     commands) however short the starting PATH is;
//   - the pod spec no longer sets PATH, and a PATH the template sets is kept.

package workloadmanager

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// A PATH shaped like a real accelerator image's: a venv and toolchain
// directories ahead of the system ones, and both sbin directories.
const imagePath = "/opt/venv/bin:/opt/rocm/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// The PATH value the pod spec carried before this change, written out rather
// than taken from the production list so the two cannot move together.
const previousPodPath = "/shared/bin:/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin:/sbin"

// startupPath runs the main container's startup command from the pod template
// under sh, with env as the container's environment, and returns the PATH its
// build steps see -- the PATH envd is exec'd with. A build step records it and
// exits before the exec. rewrite maps paths in the command to test locations.
func startupPath(t *testing.T, sh []string, env []string, rewrite func(dir, script string) string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "path")
	ci := extraCATestCI()
	ci.Spec.Template.Steps = []runtimev1alpha1.SandboxBuildStep{
		{Type: "run", Args: []string{`printf '%s' "$PATH" > ` + out + ` && exit 0`}},
	}
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(ci)
	main := pt.Spec.Containers[0]
	script := main.Args[0]
	// Keep the workspace out of the host's /home.
	script = strings.Replace(script, "mkdir -p /home/sandbox ", "mkdir -p "+filepath.Join(dir, "workspace")+" ", 1)
	if rewrite != nil {
		script = rewrite(dir, script)
	}
	cmd := exec.Command(sh[0], append(sh[1:], "-c", script)...)
	cmd.Env = env
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("startup command failed: %v\n%s\ncommand: %s", err, b, script)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("startup command never reached its build steps: %v\ncommand: %s", err, script)
	}
	return string(got)
}

func noExtraCA(t *testing.T) {
	t.Setenv("SANDBOX_EXTRA_CA_CONFIGMAP", "")
	t.Setenv("SANDBOX_EXTRA_CA_REQUIRED", "")
}

func countEntry(path, entry string) int {
	n := 0
	for _, e := range strings.Split(path, ":") {
		if e == entry {
			n++
		}
	}
	return n
}

func TestStartupKeepsImagePathFirst(t *testing.T) {
	noExtraCA(t)
	forEachShell(t, func(t *testing.T, sh []string) {
		got := startupPath(t, sh, []string{"PATH=" + imagePath}, nil)
		want := imagePath + ":/shared/bin:/home/sandbox/.local/bin"
		if got != want {
			t.Fatalf("PATH after startup:\n got %s\nwant %s", got, want)
		}
	})
}

func TestStartupCompletesAShortPathWithEveryOldEntry(t *testing.T) {
	noExtraCA(t)
	// A template that sets only its own directory, which is not even present
	// here: mkdir and the build step must still resolve.
	forEachShell(t, func(t *testing.T, sh []string) {
		got := startupPath(t, sh, []string{"PATH=/opt/venv/bin"}, nil)
		want := "/opt/venv/bin:" + previousPodPath
		if got != want {
			t.Fatalf("PATH after startup:\n got %s\nwant %s", got, want)
		}
	})
}

func TestStartupAddsEachEntryOnlyOnce(t *testing.T) {
	noExtraCA(t)
	// A template that already names /shared/bin and /usr/bin, in its own positions.
	start := "/opt/venv/bin:/shared/bin:/usr/bin:/bin"
	forEachShell(t, func(t *testing.T, sh []string) {
		got := startupPath(t, sh, []string{"PATH=" + start}, nil)
		want := start + ":/home/sandbox/.local/bin:/usr/local/bin:/sbin"
		if got != want {
			t.Fatalf("PATH after startup:\n got %s\nwant %s", got, want)
		}
		for _, e := range strings.Split(previousPodPath, ":") {
			if n := countEntry(got, e); n != 1 {
				t.Fatalf("%s appears %d times in %s", e, n, got)
			}
		}
	})
}

func TestStartupWithEmptyPathUsesPreviousValue(t *testing.T) {
	noExtraCA(t)
	forEachShell(t, func(t *testing.T, sh []string) {
		if got := startupPath(t, sh, []string{"PATH="}, nil); got != previousPodPath {
			t.Fatalf("PATH after startup:\n got %s\nwant %s", got, previousPodPath)
		}
	})
}

func TestStartupWithoutPathKeepsShellDefaultAndOldEntries(t *testing.T) {
	noExtraCA(t)
	// The container runtime gives a container with no PATH a default one, and
	// a shell started with none does the same. Either way the old entries are
	// all present once and the startup reaches its steps.
	forEachShell(t, func(t *testing.T, sh []string) {
		got := startupPath(t, sh, nil, nil)
		for _, e := range strings.Split(previousPodPath, ":") {
			if n := countEntry(got, e); n != 1 {
				t.Fatalf("%s appears %d times in %s", e, n, got)
			}
		}
	})
}

// The extra-CA check runs before the build steps and calls its commands by
// name. With a template PATH that names none of the system directories it
// must still run, because PATH is completed before it.
func TestStartupRunsExtraCACheckWithAShortPath(t *testing.T) {
	t.Setenv("SANDBOX_EXTRA_CA_CONFIGMAP", "")
	t.Setenv("SANDBOX_EXTRA_CA_REQUIRED", "true")
	// A stand-in for setup-extra-ca.sh that, like the real one, writes the
	// bundle with commands found through PATH.
	stub := "#!/bin/sh\nset -e\nd=$(dirname \"$0\")\nprintf 'pem' | cat > \"$d/ca-bundle.pem.tmp\"\nmv \"$d/ca-bundle.pem.tmp\" \"$d/ca-bundle.pem\"\n"
	forEachShell(t, func(t *testing.T, sh []string) {
		got := startupPath(t, sh, []string{"PATH=/opt/venv/bin"}, func(dir, script string) string {
			bin := filepath.Join(dir, "shared-bin")
			if err := os.MkdirAll(bin, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(bin, "setup-extra-ca.sh"), []byte(stub), 0o755); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(script, "/shared/bin/setup-extra-ca.sh") {
				t.Fatalf("startup command does not run the extra-CA check:\n%s", script)
			}
			script = strings.ReplaceAll(script, "/shared/bin/setup-extra-ca.sh", bin+"/setup-extra-ca.sh")
			return strings.ReplaceAll(script, extraCABundlePath, filepath.Join(bin, "ca-bundle.pem"))
		})
		if !strings.HasPrefix(got, "/opt/venv/bin:") || countEntry(got, "/usr/bin") != 1 {
			t.Fatalf("PATH after startup: %s", got)
		}
	})
}

func TestPodSpecDoesNotReplaceImagePath(t *testing.T) {
	noExtraCA(t)
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(extraCATestCI())
	if v, ok := envValue(pt.Spec.Containers[0].Env, "PATH"); ok {
		t.Fatalf("main container sets PATH=%q, which replaces the image's PATH", v)
	}
}

func TestPodSpecKeepsTemplatePath(t *testing.T) {
	noExtraCA(t)
	const templatePath = "/opt/tools/bin:/usr/bin:/bin"
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(extraCATestCI(corev1.EnvVar{Name: "PATH", Value: templatePath}))
	var paths []string
	for _, e := range pt.Spec.Containers[0].Env {
		if e.Name == "PATH" {
			paths = append(paths, e.Value)
		}
	}
	if len(paths) != 1 || paths[0] != templatePath {
		t.Fatalf("PATH env vars on the main container = %q, want only the template's %q", paths, templatePath)
	}
}
