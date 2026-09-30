// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// A sandbox whose environment pointed SSL_CERT_FILE at an extra CA bundle that
// nothing ever wrote started anyway, and every https call inside it failed.
// These tests pin the replacement:
//
//   - the envd-injector image ships /setup-extra-ca.sh and
//     /extra-ca-bundle.pem, the paths pod templates copy, and keeps the
//     deprecated compatibility copies self-maintained sandbox templates
//     written before the generic names still use;
//   - setup-extra-ca.sh merges the image-baked bundle and a mounted ConfigMap
//     directory with the image's system bundle, under every POSIX sh we have;
//   - a container configured to use the bundle that finds no anchor exits
//     non-zero naming both sources, so `&& exec envd` does not start it;
//   - a container that is not configured to use it behaves as before;
//   - the CodeInterpreter controller runs the same script the same way, and
//     leaves an undeclared pod exactly as it was.

package workloadmanager

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

var (
	setupScriptPath        = filepath.Join("..", "..", "docker", "scripts", "setup-extra-ca.sh")
	injectorDockerfilePath = filepath.Join("..", "..", "docker", "Dockerfile.envd-injector")
)

// The injector command before extra CA support existed. Undeclared must keep it.
const legacyInjectorCmd = "cp /envd /shared/bin/envd && (cp /tmux /shared/bin/tmux 2>/dev/null || true) && (cp /iptables /shared/bin/iptables && cp /iptables /shared/bin/ip6tables && ln -sf iptables /shared/bin/iptables-legacy && ln -sf ip6tables /shared/bin/ip6tables-legacy && cp /musl-ld.so /shared/bin/ld-musl-x86_64.so.1 && ln -sf ld-musl-x86_64.so.1 /shared/bin/libc.musl-x86_64.so.1 2>/dev/null || true)"

func extraCATestCI(env ...corev1.EnvVar) *runtimev1alpha1.CodeInterpreter {
	return &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{Name: "ci", Namespace: "ns"},
		Spec: runtimev1alpha1.CodeInterpreterSpec{
			AuthMode: runtimev1alpha1.AuthModeNone,
			Template: &runtimev1alpha1.CodeInterpreterSandboxTemplate{
				FromImage:   "python:3.12",
				Environment: env,
			},
		},
	}
}

func envValue(env []corev1.EnvVar, name string) (string, bool) {
	for _, e := range env {
		if e.Name == name {
			return e.Value, true
		}
	}
	return "", false
}

func TestExtraCAUndeclaredLeavesPodUnchanged(t *testing.T) {
	t.Setenv("SANDBOX_EXTRA_CA_CONFIGMAP", "")
	t.Setenv("SANDBOX_EXTRA_CA_REQUIRED", "")
	ci := extraCATestCI()
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(ci)

	if got := pt.Spec.InitContainers[0].Command[2]; got != legacyInjectorCmd {
		t.Fatalf("injector command changed with no extra CA declared:\n%s", got)
	}
	main := pt.Spec.Containers[0]
	if want := buildStartupScript(ci.Spec.Template.Steps, "/home/sandbox"); main.Args[0] != want {
		t.Fatalf("startup script changed with no extra CA declared:\n got %q\nwant %q", main.Args[0], want)
	}
	for _, v := range pt.Spec.Volumes {
		if v.Name == extraCAVolumeName {
			t.Fatalf("extra CA volume present with nothing declared")
		}
	}
	if main.TerminationMessagePolicy != "" {
		t.Fatalf("TerminationMessagePolicy = %q with nothing declared", main.TerminationMessagePolicy)
	}
	for _, name := range append([]string{"EXTRA_CA_REQUIRED"}, extraCABundleEnvNames...) {
		if _, ok := envValue(main.Env, name); ok {
			t.Fatalf("%s injected with nothing declared", name)
		}
	}
}

func TestExtraCAConfigMapIsMountedAndRequired(t *testing.T) {
	t.Setenv("SANDBOX_EXTRA_CA_CONFIGMAP", "my-ca")
	t.Setenv("SANDBOX_EXTRA_CA_REQUIRED", "")
	// A value the template already sets is the template's to keep.
	ci := extraCATestCI(corev1.EnvVar{Name: "NODE_EXTRA_CA_CERTS", Value: "/opt/custom.pem"})
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(ci)

	var vol *corev1.Volume
	for i := range pt.Spec.Volumes {
		if pt.Spec.Volumes[i].Name == extraCAVolumeName {
			vol = &pt.Spec.Volumes[i]
		}
	}
	if vol == nil || vol.ConfigMap == nil || vol.ConfigMap.Name != "my-ca" {
		t.Fatalf("ConfigMap volume my-ca missing: %+v", pt.Spec.Volumes)
	}
	if vol.ConfigMap.Optional != nil && *vol.ConfigMap.Optional {
		t.Fatalf("extra CA ConfigMap must not be optional")
	}

	main := pt.Spec.Containers[0]
	mounted := false
	for _, m := range main.VolumeMounts {
		if m.Name == extraCAVolumeName && m.MountPath == extraCAMountPath && m.ReadOnly {
			mounted = true
		}
	}
	if !mounted {
		t.Fatalf("extra CA not mounted read-only at %s: %+v", extraCAMountPath, main.VolumeMounts)
	}
	assertDeclaredContainers(t, pt)
	for _, name := range []string{"SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"} {
		if v, _ := envValue(main.Env, name); v != extraCABundlePath {
			t.Fatalf("%s = %q, want %s", name, v, extraCABundlePath)
		}
	}
	n := 0
	for _, e := range main.Env {
		if e.Name == "NODE_EXTRA_CA_CERTS" {
			n++
			if e.Value != "/opt/custom.pem" {
				t.Fatalf("template's NODE_EXTRA_CA_CERTS overridden: %q", e.Value)
			}
		}
	}
	if n != 1 {
		t.Fatalf("NODE_EXTRA_CA_CERTS appears %d times", n)
	}
}

func TestExtraCARequiredWithoutConfigMapUsesImageBundle(t *testing.T) {
	t.Setenv("SANDBOX_EXTRA_CA_CONFIGMAP", "")
	t.Setenv("SANDBOX_EXTRA_CA_REQUIRED", "true")
	pt := (&CodeInterpreterReconciler{}).buildPodTemplate(extraCATestCI())
	for _, v := range pt.Spec.Volumes {
		if v.Name == extraCAVolumeName {
			t.Fatalf("volume added with no ConfigMap configured")
		}
	}
	assertDeclaredContainers(t, pt)
	for _, name := range extraCABundleEnvNames {
		if v, _ := envValue(pt.Spec.Containers[0].Env, name); v != extraCABundlePath {
			t.Fatalf("%s = %q, want %s", name, v, extraCABundlePath)
		}
	}
}

// assertDeclaredContainers checks what every declared mode shares: the
// injector copies the same two files self-maintained sandbox templates copy,
// without `|| true`; the main container runs setup-extra-ca.sh before anything else and
// in strict mode; and a failure is surfaced by kubectl describe.
func assertDeclaredContainers(t *testing.T, pt sandboxv1alpha1.PodTemplate) {
	t.Helper()
	if cmd := pt.Spec.InitContainers[0].Command[2]; cmd != legacyInjectorCmd+" && cp /setup-extra-ca.sh /extra-ca-bundle.pem /shared/bin/" {
		t.Fatalf("injector does not copy /setup-extra-ca.sh and /extra-ca-bundle.pem unconditionally: %q", cmd)
	}
	main := pt.Spec.Containers[0]
	if !strings.HasPrefix(main.Args[0], "/bin/sh /shared/bin/setup-extra-ca.sh && ") {
		t.Fatalf("setup-extra-ca.sh does not run first: %q", main.Args[0])
	}
	if v, _ := envValue(main.Env, "EXTRA_CA_REQUIRED"); v != "true" {
		t.Fatalf("EXTRA_CA_REQUIRED = %q, want true", v)
	}
	if main.TerminationMessagePolicy != corev1.TerminationMessageFallbackToLogsOnError {
		t.Fatalf("TerminationMessagePolicy = %q, want FallbackToLogsOnError", main.TerminationMessagePolicy)
	}
}

// The controller mounts the ConfigMap where the script looks by default, so
// self-maintained sandbox templates and the controller share one fixed path.
func TestExtraCAMountPathIsTheScriptDefault(t *testing.T) {
	b, err := os.ReadFile(setupScriptPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`CA_DIR="${EXTRA_CA_DIR:-` + extraCAMountPath + `}"`,
		`OUT_BUNDLE="${EXTRA_CA_BUNDLE:-` + extraCABundlePath + `}"`,
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("setup-extra-ca.sh does not default to %s", want)
		}
	}
}

// ── Image contract ───────────────────────────────────────────────────────

// finalStageCopies returns dest -> source for the COPY lines of the last
// stage of the envd-injector Dockerfile, and its RUN lines.
func finalStage(t *testing.T) (copies map[string]string, runs []string) {
	t.Helper()
	f, err := os.Open(injectorDockerfilePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	copies = map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch strings.ToUpper(fields[0]) {
		case "FROM":
			copies, runs = map[string]string{}, nil
		case "COPY":
			args := fields[1:]
			src := ""
			for _, a := range args[:len(args)-1] {
				if strings.HasPrefix(a, "--from=") {
					src = a + " "
					continue
				}
				src += a
			}
			copies[args[len(args)-1]] = src
		case "RUN":
			runs = append(runs, line)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return copies, runs
}

// Pod templates outside this repository (and the controller) copy these
// paths out of the injector. Renaming any of them breaks them at run time.
// The generic names are the primary contract; the deprecated compatibility
// names must stay, with the same content, for self-maintained sandbox
// templates written before the generic names existed.
var injectorContractPaths = []struct{ script, bundle string }{
	{"/setup-extra-ca.sh", "/extra-ca-bundle.pem"}, // primary
	{"/setup-amd-ca.sh", "/amd-bundle.pem"},        // deprecated compatibility alias
}

func TestInjectorImageShipsSetupScriptAndBundleAtContractPaths(t *testing.T) {
	copies, runs := finalStage(t)
	for _, p := range injectorContractPaths {
		if got := copies[p.script]; got != "docker/scripts/setup-extra-ca.sh" {
			t.Fatalf("final image does not ship docker/scripts/setup-extra-ca.sh at %s (got %q)", p.script, got)
		}
		if got := copies[p.bundle]; got != "--from=ca-fetcher /extra-ca/ca-bundle.pem" {
			t.Fatalf("final image does not ship the ca-fetcher bundle at %s (got %q)", p.bundle, got)
		}
		executable := false
		for _, r := range runs {
			if regexp.MustCompile(`chmod\s+\+x\s+(\S+\s+)*` + regexp.QuoteMeta(p.script) + `(\s|$)`).MatchString(r) {
				executable = true
			}
		}
		if !executable {
			t.Fatalf("final image does not chmod +x %s: templates run it directly, not via sh", p.script)
		}
	}
	if _, err := os.Stat(setupScriptPath); err != nil {
		t.Fatalf("COPY source missing: %v", err)
	}
}

// ── setup-extra-ca.sh, run for real ────────────────────────────────────────

// shells returns every POSIX shell on this host to run the script under.
// /bin/sh is required; dash, busybox and bash --posix are used when present.
func shells(t *testing.T) [][]string {
	t.Helper()
	out := [][]string{{"/bin/sh"}}
	if p, err := exec.LookPath("dash"); err == nil {
		out = append(out, []string{p})
	}
	if p, err := exec.LookPath("busybox"); err == nil {
		out = append(out, []string{p, "sh"})
	}
	if p, err := exec.LookPath("bash"); err == nil {
		out = append(out, []string{p, "--posix"})
	}
	return out
}

func forEachShell(t *testing.T, fn func(t *testing.T, sh []string)) {
	for _, sh := range shells(t) {
		sh := sh
		t.Run(filepath.Base(strings.Join(sh, "_")), func(t *testing.T) { fn(t, sh) })
	}
}

func testCertPEM(t *testing.T, cn string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

type caFixture struct {
	dir, caDir, imageBundle, sysBundle, out string
}

func newCAFixture(t *testing.T) caFixture {
	d := t.TempDir()
	return caFixture{
		dir:         d,
		caDir:       filepath.Join(d, "extra-ca"),
		imageBundle: filepath.Join(d, "image-bundle.pem"),
		sysBundle:   filepath.Join(d, "system.crt"),
		out:         filepath.Join(d, "ca-bundle.pem"),
	}
}

func (f caFixture) env(extra ...string) []string {
	return append([]string{
		"PATH=" + os.Getenv("PATH"),
		"EXTRA_CA_DIR=" + f.caDir,
		"EXTRA_CA_IMAGE_BUNDLE=" + f.imageBundle,
		"EXTRA_CA_BUNDLE=" + f.out,
		"EXTRA_CA_SYSTEM_BUNDLES=" + f.sysBundle,
	}, extra...)
}

// run runs setup-extra-ca.sh under sh with the fixture's paths plus extra env.
func (f caFixture) run(t *testing.T, sh []string, extra ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(sh[0], append(sh[1:], setupScriptPath)...)
	cmd.Env = f.env(extra...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// runLikeTemplate runs `setup-extra-ca.sh && exec envd` the way a
// self-maintained sandbox template's main container does, with a stand-in envd that records it ran.
func (f caFixture) runLikeTemplate(t *testing.T, sh []string, extra ...string) (out string, err error, envdStarted bool) {
	t.Helper()
	marker := filepath.Join(f.dir, "envd-started")
	script, err := filepath.Abs(setupScriptPath)
	if err != nil {
		t.Fatal(err)
	}
	line := sh[0] + " " + strings.Join(append(sh[1:], script), " ") + " && exec touch " + marker
	cmd := exec.Command("/bin/sh", "-c", line)
	cmd.Env = f.env(extra...)
	b, err := cmd.CombinedOutput()
	_, statErr := os.Stat(marker)
	return string(b), err, statErr == nil
}

func (f caFixture) write(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// mountLikeKubelet lays out a ConfigMap volume the way the kubelet does:
// keys are symlinks into ..data, which points at a timestamped directory.
func (f caFixture) mountLikeKubelet(t *testing.T, files map[string][]byte) {
	t.Helper()
	ts := filepath.Join(f.caDir, "..2026_01_01_00_00_00.000000000")
	if err := os.MkdirAll(ts, 0o755); err != nil {
		t.Fatal(err)
	}
	for k, v := range files {
		if err := os.WriteFile(filepath.Join(ts, k), v, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("..data", k), filepath.Join(f.caDir, k)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Base(ts), filepath.Join(f.caDir, "..data")); err != nil {
		t.Fatal(err)
	}
}

func subjects(t *testing.T, bundle []byte) []string {
	t.Helper()
	var cns []string
	for {
		var b *pem.Block
		b, bundle = pem.Decode(bundle)
		if b == nil {
			break
		}
		c, err := x509.ParseCertificate(b.Bytes)
		if err != nil {
			t.Fatalf("bundle holds an unparseable certificate: %v", err)
		}
		cns = append(cns, c.Subject.CommonName)
	}
	return cns
}

// The four variables a template sets to use the bundle, and the explicit
// switch. Any one of them alone makes the script strict.
var strictTriggers = []string{
	"SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "EXTRA_CA_REQUIRED",
}

func (f caFixture) trigger(name string) string {
	if name == "EXTRA_CA_REQUIRED" {
		return "EXTRA_CA_REQUIRED=true"
	}
	return name + "=" + f.out
}

// The production failure: the image was built without a CA and the template
// points every TLS client at the bundle. Before, envd started and https
// failed everywhere. Now the container stops, naming both sources.
func TestSetupExtraCAConfiguredButNoAnchorFailsBeforeEnvd(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		for _, trig := range strictTriggers {
			for _, layout := range []string{"no-dir", "empty-configmap"} {
				t.Run(trig+"/"+layout, func(t *testing.T) {
					f := newCAFixture(t)
					f.write(t, f.sysBundle, testCertPEM(t, "system-root"))
					f.write(t, f.imageBundle, nil) // built without EXTRA_CA_CERT_URLS
					if layout == "empty-configmap" {
						f.mountLikeKubelet(t, map[string][]byte{})
					}
					out, err, envd := f.runLikeTemplate(t, sh, f.trigger(trig))
					if err == nil || envd {
						t.Fatalf("started with no extra CA (err=%v envd=%v):\n%s", err, envd, out)
					}
					for _, want := range []string{"setup-extra-ca: error:", f.imageBundle, f.caDir, "EXTRA_CA_CERT_URLS", "ConfigMap"} {
						if !strings.Contains(out, want) {
							t.Fatalf("error does not name %q:\n%s", want, out)
						}
					}
					if _, err := os.Stat(f.out); !os.IsNotExist(err) {
						t.Fatalf("a bundle was written despite the failure (stat err=%v)", err)
					}
				})
			}
		}
	})
}

// A variable pointing somewhere else is not a claim on this bundle.
func TestSetupExtraCAOtherBundlePathIsNotStrict(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		out, err, envd := f.runLikeTemplate(t, sh, "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt", "EXTRA_CA_REQUIRED=false")
		if err != nil || !envd {
			t.Fatalf("not configured for the bundle, yet failed (err=%v envd=%v):\n%s", err, envd, out)
		}
	})
}

// Nothing configured, nothing found: skip and exit 0, as the old script did,
// and write no bundle.
func TestSetupExtraCAUnconfiguredWithoutAnchorSkips(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		f.write(t, f.sysBundle, testCertPEM(t, "system-root"))
		f.write(t, f.imageBundle, nil)
		out, err, envd := f.runLikeTemplate(t, sh)
		if err != nil || !envd {
			t.Fatalf("unconfigured run failed (err=%v envd=%v):\n%s", err, envd, out)
		}
		if !strings.Contains(out, "skip") {
			t.Fatalf("no skip message:\n%s", out)
		}
		if _, err := os.Stat(f.out); !os.IsNotExist(err) {
			t.Fatalf("unconfigured run wrote %s (stat err=%v)", f.out, err)
		}
	})
}

// A template that works today: the image carries the CA, the template points
// the clients at the bundle, nothing is mounted. The bundle is the system
// anchors followed by the image's, as the old script wrote it, configured or
// not.
func TestSetupExtraCAImageBundleAloneKeepsTodaysResult(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		for _, env := range [][]string{nil, {"SSL_CERT_FILE=X", "CURL_CA_BUNDLE=X", "REQUESTS_CA_BUNDLE=X", "NODE_EXTRA_CA_CERTS=X"}} {
			f := newCAFixture(t)
			for i := range env {
				env[i] = strings.Replace(env[i], "=X", "="+f.out, 1)
			}
			f.write(t, f.sysBundle, testCertPEM(t, "system-root"))
			f.write(t, f.imageBundle, append(testCertPEM(t, "image-root"), testCertPEM(t, "image-issuing")...))
			out, err, envd := f.runLikeTemplate(t, sh, env...)
			if err != nil || !envd {
				t.Fatalf("image-baked CA failed (env=%v err=%v envd=%v):\n%s", env, err, envd, out)
			}
			bundle, err := os.ReadFile(f.out)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(subjects(t, bundle), ","); got != "system-root,image-root,image-issuing" {
				t.Fatalf("bundle subjects = %s, want system-root,image-root,image-issuing", got)
			}
		}
	})
}

// The ConfigMap path: an image with no baked CA plus a ConfigMap mounted at the
// fixed directory, in strict mode.
func TestSetupExtraCAMountedDirAloneSatisfiesStrict(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		f.write(t, f.sysBundle, testCertPEM(t, "system-root"))
		f.write(t, f.imageBundle, nil)
		f.mountLikeKubelet(t, map[string][]byte{"ca.crt": testCertPEM(t, "org-root")})
		out, err, envd := f.runLikeTemplate(t, sh, "SSL_CERT_FILE="+f.out)
		if err != nil || !envd {
			t.Fatalf("mounted CA failed (err=%v envd=%v):\n%s", err, envd, out)
		}
		bundle, _ := os.ReadFile(f.out)
		if got := strings.Join(subjects(t, bundle), ","); got != "system-root,org-root" {
			t.Fatalf("bundle subjects = %s, want system-root,org-root", got)
		}
	})
}

func TestSetupExtraCAMergesBothSourcesWithSystemBundle(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		f.write(t, f.sysBundle, testCertPEM(t, "system-root"))
		f.write(t, f.imageBundle, testCertPEM(t, "image-root"))
		f.mountLikeKubelet(t, map[string][]byte{
			"root.crt":    testCertPEM(t, "org-root"),
			"issuing.crt": testCertPEM(t, "org-issuing"),
		})
		out, err := f.run(t, sh, "EXTRA_CA_REQUIRED=true")
		if err != nil {
			t.Fatalf("merge failed: %v\n%s", err, out)
		}
		bundle, err := os.ReadFile(f.out)
		if err != nil {
			t.Fatal(err)
		}
		got := subjects(t, bundle)
		if len(got) != 4 || got[0] != "system-root" || got[1] != "image-root" {
			t.Fatalf("bundle subjects = %v, want system-root, image-root, then both org anchors", got)
		}
		joined := strings.Join(got, ",")
		if !strings.Contains(joined, "org-root") || !strings.Contains(joined, "org-issuing") {
			t.Fatalf("bundle subjects = %v, missing a mounted anchor", got)
		}
		if strings.Contains(joined, "..data") {
			t.Fatalf("kubelet dot-entries were read: %v", got)
		}
		if !x509.NewCertPool().AppendCertsFromPEM(bundle) {
			t.Fatalf("merged bundle is not loadable as a cert pool")
		}
	})
}

// A system bundle without a trailing newline must not glue its last END line
// to the next BEGIN line.
func TestSetupExtraCASystemBundleWithoutTrailingNewline(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		f.write(t, f.sysBundle, []byte(strings.TrimRight(string(testCertPEM(t, "system-root")), "\n")))
		f.write(t, f.imageBundle, testCertPEM(t, "image-root"))
		if out, err := f.run(t, sh); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		bundle, _ := os.ReadFile(f.out)
		if got := strings.Join(subjects(t, bundle), ","); got != "system-root,image-root" {
			t.Fatalf("bundle subjects = %s", got)
		}
	})
}

func TestSetupExtraCANoSystemBundleWarns(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		f := newCAFixture(t)
		f.write(t, f.imageBundle, testCertPEM(t, "image-root"))
		out, err := f.run(t, sh, "EXTRA_CA_REQUIRED=true")
		if err != nil || !strings.Contains(out, "no system CA bundle") {
			t.Fatalf("err=%v out=\n%s", err, out)
		}
		bundle, _ := os.ReadFile(f.out)
		if got := strings.Join(subjects(t, bundle), ","); got != "image-root" {
			t.Fatalf("bundle subjects = %s", got)
		}
	})
}

// A mounted key that is not a certificate is operator error, whatever mode.
func TestSetupExtraCARejectsNonPEMKey(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		for _, extra := range [][]string{nil, {"EXTRA_CA_REQUIRED=true"}} {
			f := newCAFixture(t)
			f.mountLikeKubelet(t, map[string][]byte{"root.crt": []byte("not a certificate\n")})
			out, err, envd := f.runLikeTemplate(t, sh, extra...)
			if err == nil || envd || !strings.Contains(out, "not a PEM certificate") || !strings.Contains(out, "root.crt") {
				t.Fatalf("non-PEM key accepted (env=%v err=%v envd=%v):\n%s", extra, err, envd, out)
			}
		}
	})
}

// ── The controller's startup prefix, run for real ─────────────────────────

// runControllerPrefix runs extraCASetupScript + a stand-in envd, with
// /shared/bin rewritten to a temp directory holding the given script.
func runControllerPrefix(t *testing.T, script []byte, env ...string) (string, error, bool) {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "setup-extra-ca.sh"), script, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(bin, "envd-started")
	line := strings.ReplaceAll(extraCASetupScript, "/shared/bin", bin) + "exec touch " + marker
	cmd := exec.Command("/bin/sh", "-c", line)
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, env...)
	out, err := cmd.CombinedOutput()
	_, statErr := os.Stat(marker)
	return string(out), err, statErr == nil
}

// A script that exits 0 without writing the bundle, as one from an injector
// image that predates strict mode does. The controller's own check stops the
// container instead.
func TestControllerPrefixCatchesOldSilentScript(t *testing.T) {
	old := []byte("#!/bin/sh\necho 'bundle not found; skip' >&2\nexit 0\n")
	out, err, envd := runControllerPrefix(t, old)
	if err == nil || envd || !strings.Contains(out, "was not written") || !strings.Contains(out, "predates") {
		t.Fatalf("old silent script let envd start (err=%v envd=%v):\n%s", err, envd, out)
	}
}

// The real script, strict, with no anchor: its own message, envd not started.
func TestControllerPrefixWithRealScriptFailsLoudly(t *testing.T) {
	script, err := os.ReadFile(setupScriptPath)
	if err != nil {
		t.Fatal(err)
	}
	d := t.TempDir()
	out, err, envd := runControllerPrefix(t, script,
		"EXTRA_CA_REQUIRED=true", "EXTRA_CA_DIR="+filepath.Join(d, "none"),
		"EXTRA_CA_IMAGE_BUNDLE="+filepath.Join(d, "none.pem"), "EXTRA_CA_BUNDLE="+filepath.Join(d, "out.pem"))
	if err == nil || envd || !strings.Contains(out, "no extra CA certificate was found") {
		t.Fatalf("err=%v envd=%v:\n%s", err, envd, out)
	}
}

// ── The bundle's default location, primary and compatibility names ────────

// runInstalled lays out a /shared/bin stand-in the way the injector leaves
// it: the script under scriptName and the image bundle under bundleName, then
// runs it with only the output path redirected there (no EXTRA_CA_IMAGE_BUNDLE),
// so the script finds the bundle by its default names.
func runInstalled(t *testing.T, sh []string, scriptName, bundleName string, bundle []byte) (string, error, []byte) {
	t.Helper()
	bin := t.TempDir()
	script, err := os.ReadFile(setupScriptPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, scriptName), script, 0o755); err != nil {
		t.Fatal(err)
	}
	if bundleName != "" {
		if err := os.WriteFile(filepath.Join(bin, bundleName), bundle, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sys := filepath.Join(bin, "system.crt")
	if err := os.WriteFile(sys, testCertPEM(t, "system-root"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(bin, "ca-bundle.pem")
	cmd := exec.Command(sh[0], append(sh[1:], filepath.Join(bin, scriptName))...)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"EXTRA_CA_REQUIRED=true",
		"EXTRA_CA_DIR=" + filepath.Join(bin, "no-such-dir"),
		"EXTRA_CA_BUNDLE=" + out,
		"EXTRA_CA_SYSTEM_BUNDLES=" + sys,
	}
	b, runErr := cmd.CombinedOutput()
	written, _ := os.ReadFile(out)
	return string(b), runErr, written
}

// Both the primary names and the deprecated compatibility names find the
// image-baked bundle by default, and produce the same bundle.
func TestSetupExtraCAFindsImageBundleUnderBothNames(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		for _, p := range injectorContractPaths {
			script, bundle := filepath.Base(p.script), filepath.Base(p.bundle)
			out, err, written := runInstalled(t, sh, script, bundle, testCertPEM(t, "image-root"))
			if err != nil {
				t.Fatalf("%s with %s failed: %v\n%s", script, bundle, err, out)
			}
			if got := strings.Join(subjects(t, written), ","); got != "system-root,image-root" {
				t.Fatalf("%s with %s: bundle subjects = %s, want system-root,image-root", script, bundle, got)
			}
			if !strings.Contains(out, "setup-extra-ca: wrote") {
				t.Fatalf("%s: missing setup-extra-ca log line:\n%s", script, out)
			}
		}
	})
}

// With no image bundle under either name, strict mode names the primary one.
func TestSetupExtraCANoImageBundleNamesPrimaryPath(t *testing.T) {
	forEachShell(t, func(t *testing.T, sh []string) {
		out, err, _ := runInstalled(t, sh, "setup-extra-ca.sh", "", nil)
		if err == nil || !strings.Contains(out, "extra-ca-bundle.pem") {
			t.Fatalf("err=%v, want a failure naming extra-ca-bundle.pem:\n%s", err, out)
		}
	})
}
