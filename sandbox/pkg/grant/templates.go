// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"
	"unicode"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/sandboxlayer"
)

// grantIDKey labels and annotates a CodeInterpreter created for one grant.
const grantIDKey = "agent-sandbox.io/grant-id"

// gpuResourceName is the extended resource set on a per-GPU template.
const gpuResourceName = "amd.com/gpu"

// Per-card size applied to a GPU expansion for each value its template leaves
// out (see templateResources). Card count scales these linearly.
// Each value is at most one eighth of what SaFE admits on one MI355X node, so
// any mix of sandboxes holding the node's 8 cards fits that node, and the g8
// template is admitted. The vk-mi355x flavor is 236 CPU and 2Ti memory; SaFE
// reserves 7% CPU and 5% memory, leaving 219 CPU and 1945.6Gi. Eight cards are
// 192 CPU, 1792Gi memory, 1000Gi shared memory, and 1500Gi pod storage.
const (
	cpuPerGPU      = 24
	memoryGiPerGPU = 224
	shmGiPerGPU    = 125
	imageDigestEnv = "HYPERLOOM_ACTIVE_IMAGE_DIGEST"
)

// storagePerGPU is the pod ephemeral storage for one GPU.
var storagePerGPU = resource.MustParse("187.5Gi")

// scaledStorage returns pod storage for the given card count.
func scaledStorage(gpus int32) resource.Quantity {
	q := storagePerGPU.DeepCopy()
	q.Mul(int64(gpus))
	return q
}

// registerTemplates creates a CodeInterpreter for each expansion whose spec
// names a fromImage. Specs without fromImage are skipped.
func (s *Service) registerTemplates(ctx context.Context, grantID, appRunID string, templates []runtimev1alpha1.GrantTemplate) error {
	var created []string
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			s.deleteNamedTemplates(ctx, grantID, created)
			return specError("invalid_grant", tpl.Name, err)
		}
		if !ok {
			continue
		}
		for i, name := range expandOne(appRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount}) {
			ci, err := codeInterpreter(grantID, name, base, templateGPUCount(tpl, i), s.namespace)
			if err != nil {
				s.deleteNamedTemplates(ctx, grantID, created)
				return opWrap(http.StatusBadRequest, "invalid_grant", "template "+tpl.Name+": "+err.Error(), err)
			}
			if err := s.client.Create(ctx, ci); err != nil {
				s.deleteNamedTemplates(ctx, grantID, created)
				if apierrors.IsAlreadyExists(err) {
					return opErr(http.StatusConflict, "template_exists", name)
				}
				return opWrap(http.StatusInternalServerError, "template_register_failed", name, err)
			}
			created = append(created, name)
		}
	}
	return nil
}

// validateTemplateLayers rejects a grant whose template spec declares invalid layers.
func validateTemplateLayers(templates []runtimev1alpha1.GrantTemplate) error {
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return specError("invalid_grant", tpl.Name, err)
		}
		if !ok {
			continue
		}
		if err := sandboxlayer.Validate(base.template.Layers, sandboxlayer.TemplateMounts(base.template)); err != nil {
			return opWrap(http.StatusBadRequest, "invalid_grant", "template "+tpl.Name+" layers are invalid", err)
		}
	}
	return nil
}

// validateTemplateMounts rejects a grant template whose volumes are anything
// but emptyDir volumes and read-only host directories mounted at their own
// path. A grant template comes from an application platform, which lets a
// template reach a host path only through a mount it has checked against the
// workspace (an absolute, clean path under a directory the workspace mounts
// for sandboxes): the sandbox workload mounts each hostPath volume read-only
// at the same path and has no field for another mount path, so any other
// shape would not be what it says. Other volume sources are refused, as the
// template API refuses them to a caller who is not an administrator.
//
// A read-only mount nested inside a read-write workspace mount (workspace
// /shared, template /shared/team/cache) relies on the nested mount being
// applied after its parent. The workload's mounts are ordered by path depth
// before the pod is made, and the runtimes order them again: Kubernetes CRI
// runtimes and the Docker daemon sort a container's mounts by path depth, and
// Apptainer sorts its user binds the same way.
func validateTemplateMounts(templates []runtimev1alpha1.GrantTemplate) error {
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return specError("invalid_grant", tpl.Name, err)
		}
		if !ok {
			continue
		}
		if err := checkTemplateMounts(base.template); err != nil {
			return opWrap(http.StatusBadRequest, "invalid_grant", "template "+tpl.Name+": "+err.Error(), err)
		}
	}
	return nil
}

// checkTemplateMounts holds one template to validateTemplateMounts.
func checkTemplateMounts(tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate) error {
	hostPaths := map[string]string{}
	names := map[string]bool{}
	for _, vol := range tmpl.Volumes {
		if names[vol.Name] {
			return fmt.Errorf("volume %q is defined twice", vol.Name)
		}
		names[vol.Name] = true
		switch {
		case vol.EmptyDir != nil && vol.VolumeSource == (corev1.VolumeSource{EmptyDir: vol.EmptyDir}):
		case vol.HostPath != nil && vol.VolumeSource == (corev1.VolumeSource{HostPath: vol.HostPath}):
			if err := checkMountPath(vol.HostPath.Path); err != nil {
				return fmt.Errorf("volume %q: %w", vol.Name, err)
			}
			hostPaths[vol.Name] = vol.HostPath.Path
		default:
			return fmt.Errorf("volume %q is neither an emptyDir nor a hostPath volume", vol.Name)
		}
	}
	mounted := map[string]bool{}
	for _, m := range tmpl.VolumeMounts {
		if !names[m.Name] {
			return fmt.Errorf("volume mount %q names no volume of the template", m.Name)
		}
		hostPath, ok := hostPaths[m.Name]
		if !ok {
			continue
		}
		if mounted[m.Name] {
			return fmt.Errorf("volume %q is mounted twice", m.Name)
		}
		mounted[m.Name] = true
		if m.MountPath != hostPath || m.SubPath != "" {
			return fmt.Errorf("volume %q must be mounted at its hostPath %s, without subPath", m.Name, hostPath)
		}
		if m.ReadOnly != nil && !*m.ReadOnly {
			return fmt.Errorf("volume %q must be mounted read-only", m.Name)
		}
	}
	for name := range hostPaths {
		if !mounted[name] {
			return fmt.Errorf("volume %q is not mounted", name)
		}
	}
	// A sidecar mounts a volume with Kubernetes' own default, read-write: a
	// host directory is the main container's alone.
	for _, c := range tmpl.Sidecars {
		for _, m := range c.VolumeMounts {
			if _, ok := hostPaths[m.Name]; ok {
				return fmt.Errorf("sidecar %q mounts host directory volume %q", c.Name, m.Name)
			}
		}
		for _, d := range c.VolumeDevices {
			if _, ok := hostPaths[d.Name]; ok {
				return fmt.Errorf("sidecar %q uses host directory volume %q as a device", c.Name, d.Name)
			}
		}
	}
	return nil
}

// checkMountPath accepts an absolute, clean path other than / that a bind
// spec can carry (no ':' or ',', no blank or control character).
func checkMountPath(p string) error {
	if !strings.HasPrefix(p, "/") || p == "/" || path.Clean(p) != p {
		return fmt.Errorf("hostPath %q must be an absolute, clean path other than /", p)
	}
	for _, r := range p {
		if r == ':' || r == ',' || unicode.IsSpace(r) || unicode.IsControl(r) {
			return fmt.Errorf("hostPath %q must not contain ':', ',', a blank or a control character", p)
		}
	}
	return nil
}

// validateTemplateResources rejects a template whose resources or shared
// memory cannot be resolved for one of the card counts it is expanded for.
// reason is the error reason of the caller (invalid_grant, invalid_owner_policy).
func validateTemplateResources(templates []runtimev1alpha1.GrantTemplate, reason string) error {
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return specError(reason, tpl.Name, err)
		}
		if !ok {
			continue
		}
		counts := tpl.PerGPUCount
		if len(counts) == 0 {
			counts = []int32{0}
		}
		for _, gpus := range counts {
			if _, _, err := templateResources(base, gpus); err != nil {
				return opWrap(http.StatusBadRequest, reason, "template "+tpl.Name+": "+err.Error(), err)
			}
		}
	}
	return nil
}

// resolveTemplateGPUCounts records quota counts independently of template names.
func (s *Service) resolveTemplateGPUCounts(ctx context.Context, appRunID string, templates []runtimev1alpha1.GrantTemplate) error {
	for i := range templates {
		tpl := &templates[i]
		if len(tpl.PerGPUCount) > 0 {
			tpl.GPUCounts = append([]int32(nil), tpl.PerGPUCount...)
			continue
		}
		_, generated, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return specError("invalid_grant", tpl.Name, err)
		}
		if generated {
			tpl.GPUCounts = []int32{0}
			continue
		}
		name := expandOne(appRunID, TemplateRequest{Name: tpl.Name})[0]
		ci := &runtimev1alpha1.CodeInterpreter{}
		if err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, ci); err != nil {
			if apierrors.IsNotFound(err) {
				return opErr(http.StatusBadRequest, "invalid_grant", "template "+name+" does not exist")
			}
			return opWrap(http.StatusInternalServerError, "template_get_failed", name, err)
		}
		count := int32(0)
		if ci.Spec.GPU != nil {
			count = int32(ci.Spec.GPU.Count)
		}
		tpl.GPUCounts = []int32{count}
	}
	return nil
}

// checkResolvedGPUs rejects a template whose card count exceeds the attestation.
func (s *Service) checkResolvedGPUs(token string, templates []runtimev1alpha1.GrantTemplate) error {
	limit, err := s.attest.GPULimit(token)
	if err != nil {
		return err
	}
	for _, tpl := range templates {
		for _, n := range tpl.GPUCounts {
			if int(n) > limit {
				return opErr(http.StatusBadRequest, "attestation_invalid", "maxGpusPerSandbox is below a template card count")
			}
		}
	}
	return nil
}

// specError is the 400 for a template spec that cannot be read.
func specError(reason, name string, err error) *OpError {
	return opWrap(http.StatusBadRequest, reason, "template "+name+" spec is invalid: "+err.Error(), err)
}

func templateGPUCount(tpl runtimev1alpha1.GrantTemplate, index int) int32 {
	if index >= 0 && index < len(tpl.GPUCounts) {
		return tpl.GPUCounts[index]
	}
	if index >= 0 && index < len(tpl.PerGPUCount) {
		return tpl.PerGPUCount[index]
	}
	return 0
}

// deleteTemplates removes CodeInterpreters this grant registered.
func (s *Service) deleteTemplates(ctx context.Context, g *runtimev1alpha1.SandboxGrant) error {
	s.deleteNamedTemplates(ctx, g.Name, expandedNames(g))
	return nil
}

func (s *Service) deleteNamedTemplates(ctx context.Context, grantID string, names []string) {
	for _, name := range names {
		ci := &runtimev1alpha1.CodeInterpreter{}
		err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, ci)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			continue
		}
		if !ownedByGrant(ci, grantID) {
			continue
		}
		_ = s.client.Delete(ctx, ci)
	}
}

func expandedNames(g *runtimev1alpha1.SandboxGrant) []string {
	var names []string
	for _, tpl := range g.Spec.Templates {
		names = append(names, expandOne(g.Spec.Issuer.AppRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount})...)
	}
	return names
}

// codeInterpreter builds the CodeInterpreter of one expansion of a template.
// The template's resources and shared memory are resolved by templateResources.
func codeInterpreter(grantID, name string, base *templateSpec, gpus int32, namespace string) (*runtimev1alpha1.CodeInterpreter, error) {
	resources, shm, err := templateResources(base, gpus)
	if err != nil {
		return nil, err
	}
	tmpl := &runtimev1alpha1.CodeInterpreterSandboxTemplate{}
	base.template.DeepCopyInto(tmpl)
	tmpl.Resources = resources
	if digest := digestOf(tmpl.FromImage); digest != "" {
		tmpl.Environment = append(tmpl.Environment, corev1.EnvVar{Name: imageDigestEnv, Value: digest})
	}
	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Annotations: map[string]string{grantIDKey: grantID},
		},
		Spec: runtimev1alpha1.CodeInterpreterSpec{Template: tmpl},
	}
	if len(grantID) <= 63 {
		ci.Labels = map[string]string{grantIDKey: grantID}
	}
	if gpus > 0 {
		ci.Spec.GPU = &runtimev1alpha1.GPUConfig{
			Count:        int(gpus),
			ResourceName: gpuResourceName,
			SharedMemory: shm,
		}
	}
	if measurementTemplate(name) {
		ci.Spec.RuntimePolicy = "agent-restricted"
	}
	return ci, nil
}

// sizedResources are the resources a GPU template may size itself. Every
// other resource name is refused on a GPU template: the card count comes from
// perGpuCount alone.
var sizedResources = []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory, corev1.ResourceEphemeralStorage}

// perGPUDefault is the value of name for a template that leaves it out.
func perGPUDefault(name corev1.ResourceName, gpus int32) resource.Quantity {
	switch name {
	case corev1.ResourceCPU:
		return resource.MustParse(fmt.Sprintf("%d", cpuPerGPU*gpus))
	case corev1.ResourceMemory:
		return resource.MustParse(fmt.Sprintf("%dGi", memoryGiPerGPU*gpus))
	default:
		return scaledStorage(gpus)
	}
}

// templateResources resolves the container resources and the /dev/shm size of
// one expansion of a template with gpus cards.
//
// For a GPU template (gpus > 0), each of cpu, memory and ephemeral-storage is
// resolved on its own:
//   - set in both requests and limits: both are used as given;
//   - set in requests only: the limit is the request;
//   - set in limits only: the request is the limit;
//   - set in neither: both are the per-card default times gpus (24 CPU,
//     224Gi memory, 187.5Gi storage per card).
//
// /dev/shm is the spec's gpu.sharedMemory when set, else 125Gi per card,
// lowered to the memory limit when that is smaller (shared memory is charged to
// the container's memory). Every value given must be positive, a request may
// not exceed its limit, and a given sharedMemory may not exceed the memory
// limit. Any other resource name is refused.
//
// A template without cards (gpus == 0) keeps its resources as written; the
// values it gives are checked the same way, and it may not set sharedMemory.
func templateResources(spec *templateSpec, gpus int32) (corev1.ResourceRequirements, string, error) {
	given := spec.template.Resources
	for _, name := range sizedResources {
		if err := checkPair(name, given.Requests, given.Limits); err != nil {
			return corev1.ResourceRequirements{}, "", err
		}
	}
	if gpus <= 0 {
		if spec.sharedMemory != nil {
			return corev1.ResourceRequirements{}, "", fmt.Errorf("gpu.sharedMemory is set on a template without GPUs (no perGpuCount)")
		}
		return *given.DeepCopy(), "", nil
	}
	for _, list := range []corev1.ResourceList{given.Requests, given.Limits} {
		for name := range list {
			if !sized(name) {
				return corev1.ResourceRequirements{}, "", fmt.Errorf("resources may set only cpu, memory and ephemeral-storage on a GPU template, not %s; the GPU count comes from perGpuCount", name)
			}
		}
	}
	out := corev1.ResourceRequirements{Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{}}
	for _, name := range sizedResources {
		req, hasReq := given.Requests[name]
		lim, hasLim := given.Limits[name]
		switch {
		case hasReq && hasLim:
		case hasReq:
			lim = req.DeepCopy()
		case hasLim:
			req = lim.DeepCopy()
		default:
			req = perGPUDefault(name, gpus)
			lim = req.DeepCopy()
		}
		out.Requests[name] = req.DeepCopy()
		out.Limits[name] = lim.DeepCopy()
	}
	memory := out.Limits[corev1.ResourceMemory]
	if spec.sharedMemory != nil {
		shm := *spec.sharedMemory
		if shm.Sign() <= 0 {
			return corev1.ResourceRequirements{}, "", fmt.Errorf("gpu.sharedMemory must be positive, got %s", shm.String())
		}
		if shm.Cmp(memory) > 0 {
			return corev1.ResourceRequirements{}, "", fmt.Errorf("gpu.sharedMemory %s exceeds the memory limit %s", shm.String(), memory.String())
		}
		return out, shm.String(), nil
	}
	shm := resource.MustParse(fmt.Sprintf("%dGi", shmGiPerGPU*gpus))
	if shm.Cmp(memory) > 0 {
		shm = memory.DeepCopy()
	}
	return out, shm.String(), nil
}

// checkPair rejects a non-positive value of name and a request above its limit.
func checkPair(name corev1.ResourceName, requests, limits corev1.ResourceList) error {
	req, hasReq := requests[name]
	lim, hasLim := limits[name]
	if hasReq && req.Sign() <= 0 {
		return fmt.Errorf("resources.requests.%s must be positive, got %s", name, req.String())
	}
	if hasLim && lim.Sign() <= 0 {
		return fmt.Errorf("resources.limits.%s must be positive, got %s", name, lim.String())
	}
	if hasReq && hasLim && req.Cmp(lim) > 0 {
		return fmt.Errorf("resources.requests.%s %s exceeds resources.limits.%s %s", name, req.String(), name, lim.String())
	}
	return nil
}

func sized(name corev1.ResourceName) bool {
	for _, n := range sizedResources {
		if n == name {
			return true
		}
	}
	return false
}

// measurementTemplate reports whether name is the measurement template or one
// of its per-GPU expansions, such as ar-01ja-measurement-g8.
func measurementTemplate(name string) bool {
	base := name
	if i := strings.LastIndex(name, "-g"); i > 0 && digitsOnly(name[i+2:]) {
		base = name[:i]
	}
	return base == "measurement" || strings.HasSuffix(base, "-measurement")
}

func digitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func ownedByGrant(ci *runtimev1alpha1.CodeInterpreter, grantID string) bool {
	if ci.Labels != nil && ci.Labels[grantIDKey] == grantID {
		return true
	}
	return ci.Annotations != nil && ci.Annotations[grantIDKey] == grantID
}

// templateSpec is a template spec as the grant stores it: the CodeInterpreter
// template, and the /dev/shm size the spec asks for in gpu.sharedMemory (nil
// when it asks for none).
type templateSpec struct {
	template     *runtimev1alpha1.CodeInterpreterSandboxTemplate
	sharedMemory *resource.Quantity
}

// templateFromSpec reads a template spec. It is either the template itself
// (fromImage at the top) or {"template": {...}}; in both forms a GPU template
// may add {"gpu": {"sharedMemory": "<quantity>"}} at the top. The card count is
// never read from the spec.
func templateFromSpec(spec string) (*templateSpec, bool, error) {
	if spec == "" {
		return nil, false, nil
	}
	var body struct {
		FromImage string                                          `json:"fromImage"`
		Template  *runtimev1alpha1.CodeInterpreterSandboxTemplate `json:"template"`
		GPU       json.RawMessage                                 `json:"gpu"`
	}
	if err := json.Unmarshal([]byte(spec), &body); err != nil {
		return nil, false, err
	}
	var tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate
	switch {
	case body.Template != nil && body.Template.FromImage != "":
		tmpl = body.Template
	case body.FromImage == "":
		return nil, false, nil
	default:
		var flat runtimev1alpha1.CodeInterpreterSandboxTemplate
		if err := json.Unmarshal([]byte(spec), &flat); err != nil {
			return nil, false, err
		}
		tmpl = &flat
	}
	shm, err := sharedMemoryOf(body.GPU)
	if err != nil {
		return nil, false, err
	}
	return &templateSpec{template: tmpl, sharedMemory: shm}, true, nil
}

// sharedMemoryOf reads the spec's gpu object. Only sharedMemory is used.
// count, product and resourceName are the CodeInterpreter gpu fields; they are
// accepted and ignored, as they always were, because the card count and
// resource name are the grant's (perGpuCount) and an owner policy stored with
// them must keep applying. Any other key is refused rather than ignored, so a
// misspelt sharedMemory is not silently dropped.
func sharedMemoryOf(raw json.RawMessage) (*resource.Quantity, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var gpu struct {
		SharedMemory *resource.Quantity `json:"sharedMemory"`
		Count        json.RawMessage    `json:"count"`
		Product      json.RawMessage    `json:"product"`
		ResourceName json.RawMessage    `json:"resourceName"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&gpu); err != nil {
		return nil, fmt.Errorf("gpu may set only sharedMemory (count, product and resourceName are ignored): %w", err)
	}
	return gpu.SharedMemory, nil
}

func digestOf(image string) string {
	const marker = "@sha256:"
	i := strings.Index(image, marker)
	if i < 0 {
		return ""
	}
	digest := image[i+1:]
	if len(digest) <= len("sha256:") {
		return ""
	}
	return digest
}
