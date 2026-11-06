// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// The main container's startup command, as the pod template carries it, runs
// the template's build steps and envd under umask 002 whatever umask the image
// starts with, as a sandbox SaFE renders does, so what a session creates is
// writable by the group of the directory it lands in. A build step records the
// umask it runs under, which is the one envd is exec'd with, and exits before
// the exec.
func TestStartupRunsBuildStepsAndEnvdUnderUmask002(t *testing.T) {
	noExtraCA(t)
	forEachShell(t, func(t *testing.T, sh []string) {
		for _, imageUmask := range []string{"022", "077"} {
			dir := t.TempDir()
			out := filepath.Join(dir, "umask")
			ci := extraCATestCI()
			ci.Spec.Template.Steps = []runtimev1alpha1.SandboxBuildStep{
				{Type: "run", Args: []string{`umask > ` + out + ` && exit 0`}},
			}
			script := (&CodeInterpreterReconciler{}).buildPodTemplate(ci).Spec.Containers[0].Args[0]
			// Keep the workspace out of the host's /app.
			script = strings.Replace(script, "mkdir -p /app/work ", "mkdir -p "+filepath.Join(dir, "workspace")+" ", 1)
			cmd := exec.Command(sh[0], append(sh[1:], "-c", "umask "+imageUmask+"; "+script)...)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
			if b, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("startup command failed: %v\n%s\ncommand: %s", err, b, script)
			}
			got, err := os.ReadFile(out)
			if err != nil {
				t.Fatalf("startup command never reached its build steps: %v\ncommand: %s", err, script)
			}
			if u := strings.TrimSpace(string(got)); u != "0002" && u != "002" {
				t.Errorf("image umask %s: build steps ran under umask %s, want 0002", imageUmask, u)
			}
		}
	})
}
