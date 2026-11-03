// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/sandboxlayer"
)

const (
	// RouterPublicKeyConfigMap holds the cluster Router public key in each sandbox namespace.
	RouterPublicKeyConfigMap = "envd-router-public-key"

	safeEnvdBinVolume       = "envd-bin"
	safeEnvdBinMount        = "/shared/bin"
	safeSigningKeyVolume    = "signing-key"
	safeSigningKeyMount     = "/run/signing-key"
	safeSigningSecretVolume = "signing-secret"
	safeSessionVolume       = "envd-session-identity"
	safeSessionMount        = "/var/run/agent-sandbox/session"
	safeSessionAnnotation   = "runtime.agent-sandbox.io/session-id"
	safeEnvdInjectorName    = "envd-injector"
	// safeWorkloadManagerURL is the Workload Manager Service in the data-plane cluster.
	safeWorkloadManagerURL = "http://workloadmanager.agent-sandbox-system.svc.cluster.local:8080"
)

// safeEnvdInjectorScript copies envd, its tools and the AMD CA files into /shared/bin,
// then the signing key from the Secret mount into the memory volume, mode 0400, owned by the sandbox user.
// SIGNING_KEY_REQUIRED fails the container when no key is mounted.
const safeEnvdInjectorScript = `set -e
cp /envd /shared/bin/envd
cp /tmux /shared/bin/tmux 2>/dev/null || true
cp /iptables /shared/bin/iptables
cp /iptables /shared/bin/ip6tables
ln -sf iptables /shared/bin/iptables-legacy
ln -sf ip6tables /shared/bin/ip6tables-legacy
cp /musl-ld.so /shared/bin/ld-musl-x86_64.so.1
ln -sf ld-musl-x86_64.so.1 /shared/bin/libc.musl-x86_64.so.1 2>/dev/null || true
( cp /amd-root-ca.crt /amd-issuing-ca.crt /amd-bundle.pem /setup-amd-ca.sh /shared/bin/ \
  && chmod +x /shared/bin/setup-amd-ca.sh ) 2>/dev/null || true
for f in /etc/secrets/*/signing-key.pem; do
  if [ -f "$f" ]; then
    umask 077
    cp "$f" /run/signing-key/signing-key.pem
    chown 1000:1000 /run/signing-key/signing-key.pem
    chmod 0400 /run/signing-key/signing-key.pem
    break
  fi
done
if [ -n "${SIGNING_KEY_REQUIRED-}" ] && [ ! -f /run/signing-key/signing-key.pem ]; then
  echo "signing key secret is not mounted" >&2
  exit 1
fi`

// safeStartupTail runs after the PATH setup: work directories, AMD CA setup, a signing key
// passed as PEM written to HYPERLOOM_SIGNING_KEY_FILE outside /app, the template steps, then envd.
const safeStartupTail = `mkdir -p /app /app/work && /shared/bin/setup-amd-ca.sh && if [ -n "${HYPERLOOM_SIGNING_KEY_PEM-}" ]; then keyfile="${HYPERLOOM_SIGNING_KEY_FILE:-/dev/shm/hyperloom-signing-key.pem}"; case "$keyfile" in /app|/app/*) echo "signing key path is under /app" >&2; exit 1;; esac; mkdir -p "$(dirname "$keyfile")"; umask 077; printf '%s\n' "$HYPERLOOM_SIGNING_KEY_PEM" > "$keyfile"; chmod 0400 "$keyfile"; unset HYPERLOOM_SIGNING_KEY_PEM; export HYPERLOOM_SIGNING_KEY_FILE="$keyfile"; fi && if [ -n "${SANDBOX_STARTUP-}" ]; then eval "$SANDBOX_STARTUP"; fi && exec /shared/bin/envd --port=8080 --workspace=/app`

// safeStartupScript is the main-container command of a SaFE sandbox.
func safeStartupScript() string { return pathSetupScript() + safeStartupTail }

// applySafePodParts sets the SaFE Workload command, probe, env, init containers, volumes and mounts
// that run envd: the injector, the signing key copy, the session identity file, the Router public
// key and the template layers. signingSecret is the general Secret holding the key, or "".
func applySafePodParts(spec map[string]any, env map[string]any, tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate, signingSecret string) error {
	layers, err := sandboxlayer.Resolve(tmpl.Layers, sandboxlayer.TemplateMounts(tmpl))
	if err != nil {
		return err
	}
	env["HSA_ENABLE_IPC_MODE_LEGACY"] = "0"
	env["WORKLOAD_MANAGER_URL"] = safeWorkloadManagerURL
	env["HYPERLOOM_SIGNING_KEY_FILE"] = signingKeyFilePath

	volumes := []any{
		map[string]any{"name": safeEnvdBinVolume, "emptyDir": map[string]any{}},
		map[string]any{"name": safeSigningKeyVolume, "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
		map[string]any{"name": safeSessionVolume, "downwardAPI": []any{
			map[string]any{"path": "session-id", "fieldPath": "metadata.annotations['" + safeSessionAnnotation + "']"},
		}},
	}
	injectorMounts := []any{
		map[string]any{"name": safeEnvdBinVolume, "mountPath": safeEnvdBinMount},
		map[string]any{"name": safeSigningKeyVolume, "mountPath": safeSigningKeyMount},
	}
	injector := map[string]any{
		"name":    safeEnvdInjectorName,
		"image":   envdInjectorImage(),
		"command": []any{"sh", "-c", safeEnvdInjectorScript},
	}
	if signingSecret != "" {
		volumes = append(volumes, map[string]any{"name": safeSigningSecretVolume, "secret": signingSecret})
		injectorMounts = append(injectorMounts, map[string]any{
			"name": safeSigningSecretVolume, "mountPath": signingSecretMountRoot + "/" + signingSecret, "readOnly": true,
		})
		injector["env"] = []any{map[string]any{"name": "SIGNING_KEY_REQUIRED", "value": "1"}}
	}
	injector["volumeMounts"] = injectorMounts
	inits := []any{injector}
	mounts := []any{
		map[string]any{"name": safeEnvdBinVolume, "mountPath": safeEnvdBinMount},
		map[string]any{"name": safeSigningKeyVolume, "mountPath": safeSigningKeyMount},
		map[string]any{"name": safeSessionVolume, "mountPath": safeSessionMount, "readOnly": true},
	}

	layerInits, layerVolumes, layerMounts := sandboxlayer.PodParts(layers, tmpl.ImagePullPolicy)
	for _, v := range layerVolumes {
		volumes = append(volumes, map[string]any{"name": v.Name, "emptyDir": map[string]any{}})
	}
	for _, c := range layerInits {
		command := make([]any, 0, len(c.Command))
		for _, arg := range c.Command {
			command = append(command, arg)
		}
		inits = append(inits, map[string]any{
			"name":    c.Name,
			"image":   c.Image,
			"command": command,
			"volumeMounts": []any{
				map[string]any{"name": c.VolumeMounts[0].Name, "mountPath": c.VolumeMounts[0].MountPath},
			},
		})
	}
	for _, m := range layerMounts {
		mount := map[string]any{"name": m.Name, "mountPath": m.MountPath}
		if m.ReadOnly {
			mount["readOnly"] = true
		}
		mounts = append(mounts, mount)
	}

	spec["entryPoints"] = []any{safeStartupScript()}
	spec["readiness"] = map[string]any{
		"path":                "/health",
		"port":                int64(envdPort),
		"initialDelaySeconds": int64(1),
		"periodSeconds":       int64(2),
		"failureThreshold":    int64(30),
		"timeoutSeconds":      int64(2),
	}
	spec["initContainers"] = inits
	spec["volumes"] = volumes
	spec["volumeMounts"] = mounts
	spec["envRefs"] = []any{
		map[string]any{"name": "NODE_NAME", "fieldPath": "spec.nodeName"},
		map[string]any{"name": "ENVD_AUTH_PUBLIC_KEY", "configMapKeyRef": map[string]any{
			"name": RouterPublicKeyConfigMap, "key": PublicKeyDataKey,
		}},
	}
	return nil
}
