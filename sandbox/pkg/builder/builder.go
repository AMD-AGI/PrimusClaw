// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package builder provides Dockerfile-based image building for sandbox templates.
// It uses kaniko to build images inside the K8s cluster, with content-based
// caching to avoid redundant builds.
package builder

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Config holds builder configuration.
type Config struct {
	Registry       string        // target registry (e.g. "registry.example.com/agent-sandbox/")
	Namespace      string        // namespace for build pods
	CacheRepo      string        // kaniko cache repository
	BuildTimeout   time.Duration // max build time
	CPULimit       string
	MemoryLimit    string
	RegistrySecret string // K8s Secret name containing .dockerconfigjson (for kaniko push auth)
	KanikoImage    string // kaniko executor image; see DefaultKanikoImage
}

// DefaultKanikoImage is pinned by digest as well as tag. Kaniko runs inside the
// cluster with registry push credentials mounted, so silently picking up a new
// build of a moving tag would change what that credential is handed to. The tag
// is kept alongside the digest for readability and so dependabot can bump both.
const DefaultKanikoImage = "gcr.io/kaniko-project/executor:v1.24.0@sha256:4e7a52dd1f14872430652bb3b027405b8dfd17c4538751c620ac005741ef9698"

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		Namespace:      "agent-sandbox-system",
		BuildTimeout:   10 * time.Minute,
		CPULimit:       "2",
		MemoryLimit:    "4Gi",
		RegistrySecret: "registry-credentials",
		KanikoImage:    DefaultKanikoImage,
	}
}

// Builder manages kaniko-based image builds within the cluster.
type Builder struct {
	cfg    Config
	client client.Client
	cache  ImageCache
}

// ImageCache stores Dockerfile hash → image address mappings.
type ImageCache interface {
	Get(ctx context.Context, hash string) (string, bool)
	Set(ctx context.Context, hash string, image string, ttl time.Duration) error
	Delete(ctx context.Context, hash string) error
}

// New creates a Builder.
func New(cfg Config, k8sClient client.Client, cache ImageCache) *Builder {
	return &Builder{cfg: cfg, client: k8sClient, cache: cache}
}

// BuildResult holds the outcome of a build.
type BuildResult struct {
	Image    string
	Cached   bool
	Duration time.Duration
	Hash     string
}

// Build builds an image from the given Dockerfile content.
func (b *Builder) Build(ctx context.Context, templateName, dockerfile string) (*BuildResult, error) {
	hash := contentHash(dockerfile)

	if image, ok := b.cache.Get(ctx, hash); ok {
		slog.Info("builder: cache hit", "template", templateName, "hash", hash[:12], "image", image)
		return &BuildResult{Image: image, Cached: true, Hash: hash}, nil
	}

	image := fmt.Sprintf("%s%s:%s", b.cfg.Registry, templateName, hash[:12])
	start := time.Now()

	pod := b.buildKanikoPod(templateName, hash[:12], dockerfile, image)
	if err := b.client.Create(ctx, pod); err != nil {
		return nil, fmt.Errorf("create build pod: %w", err)
	}

	slog.Info("builder: build started", "template", templateName, "pod", pod.Name, "image", image)

	if err := b.waitForPod(ctx, pod.Namespace, pod.Name); err != nil {
		return nil, fmt.Errorf("build failed: %w", err)
	}

	duration := time.Since(start)

	if err := b.cache.Set(ctx, hash, image, 30*24*time.Hour); err != nil {
		slog.Warn("builder: cache set failed", "error", err)
	}

	return &BuildResult{Image: image, Duration: duration, Hash: hash}, nil
}

func (b *Builder) buildKanikoPod(templateName, shortHash, dockerfile, targetImage string) *corev1.Pod {
	podName := fmt.Sprintf("build-%s-%s", templateName, shortHash)
	if len(podName) > 63 {
		podName = podName[:63]
	}

	args := []string{
		"--dockerfile=/workspace/Dockerfile",
		"--context=dir:///workspace",
		"--destination=" + targetImage,
		"--insecure",
		"--skip-tls-verify",
		"--cache=true",
	}
	if b.cfg.CacheRepo != "" {
		args = append(args, "--cache-repo="+b.cfg.CacheRepo)
	}

	volumes := []corev1.Volume{
		{
			Name: "workspace",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		},
	}

	volumeMounts := []corev1.VolumeMount{
		{Name: "workspace", MountPath: "/workspace"},
	}

	// A Config built literally rather than from DefaultConfig leaves this empty,
	// which would produce a pod with no image rather than an obvious error.
	kanikoImage := b.cfg.KanikoImage
	if kanikoImage == "" {
		kanikoImage = DefaultKanikoImage
	}

	// Mount registry credentials if configured
	if b.cfg.RegistrySecret != "" {
		volumes = append(volumes, corev1.Volume{
			Name: "docker-config",
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: b.cfg.RegistrySecret,
					Items: []corev1.KeyToPath{
						{Key: ".dockerconfigjson", Path: "config.json"},
					},
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      "docker-config",
			MountPath: "/kaniko/.docker",
		})
	}

	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: b.cfg.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/component":       "builder",
				"app.kubernetes.io/part-of":         "agent-sandbox",
				"builder.agent-sandbox.io/template": templateName,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy:                corev1.RestartPolicyNever,
			AutomountServiceAccountToken: boolPtr(false),
			InitContainers: []corev1.Container{
				{
					Name:    "write-dockerfile",
					Image:   "busybox",
					Command: []string{"sh", "-c", "echo \"$DOCKERFILE_CONTENT\" > /workspace/Dockerfile"},
					Env: []corev1.EnvVar{
						{Name: "DOCKERFILE_CONTENT", Value: dockerfile},
					},
					VolumeMounts: []corev1.VolumeMount{
						{Name: "workspace", MountPath: "/workspace"},
					},
				},
			},
			Containers: []corev1.Container{
				{
					Name:         "kaniko",
					Image:        kanikoImage,
					Args:         args,
					VolumeMounts: volumeMounts,
					Resources: corev1.ResourceRequirements{
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse(b.cfg.CPULimit),
							corev1.ResourceMemory: resource.MustParse(b.cfg.MemoryLimit),
						},
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("500m"),
							corev1.ResourceMemory: resource.MustParse("512Mi"),
						},
					},
				},
			},
			Volumes: volumes,
		},
	}
}

func (b *Builder) waitForPod(ctx context.Context, namespace, name string) error {
	deadline := time.Now().Add(b.cfg.BuildTimeout)
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				return fmt.Errorf("build timed out after %v", b.cfg.BuildTimeout)
			}
			pod := &corev1.Pod{}
			if err := b.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, pod); err != nil {
				return fmt.Errorf("get build pod: %w", err)
			}
			switch pod.Status.Phase {
			case corev1.PodSucceeded:
				return nil
			case corev1.PodFailed:
				msg := "unknown"
				if len(pod.Status.ContainerStatuses) > 0 {
					if t := pod.Status.ContainerStatuses[0].State.Terminated; t != nil {
						msg = t.Message
					}
				}
				return fmt.Errorf("build pod failed: %s", msg)
			}
		}
	}
}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(strings.TrimSpace(content)))
	return fmt.Sprintf("%x", h)
}

func boolPtr(b bool) *bool { return &b }
