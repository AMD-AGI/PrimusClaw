// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package authz

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sfake "k8s.io/client-go/kubernetes/fake"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// verbReviewer allows the verbs named in allow. err fails every review.
type verbReviewer struct {
	allow map[string]bool
	err   error
}

func (r verbReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	if r.err != nil {
		return nil, r.err
	}
	out := sar.DeepCopy()
	if sar.Spec.ResourceAttributes != nil {
		out.Status.Allowed = r.allow[sar.Spec.ResourceAttributes.Verb]
	}
	return out, nil
}

func metric(question, result string) float64 {
	return testutil.ToFloat64(reviews.WithLabelValues(question, result))
}

func TestPlatformRoleAdminMayDeleteSessions(t *testing.T) {
	before := metric("sessions", "allow")
	c := NewClient(verbReviewer{allow: map[string]bool{"delete": true}}, "primus:")
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-admin", Groups: []string{"system-admin"}})
	if err != nil || role != identity.RoleSystemAdmin {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "allow") != before+1 {
		t.Fatal("an allowed delete review was not counted")
	}
}

func TestPlatformRoleReadonlyMayListSessions(t *testing.T) {
	deny, allow := metric("sessions", "deny"), metric("sessions", "allow")
	c := NewClient(verbReviewer{allow: map[string]bool{"list": true}}, "primus:")
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-audit", Groups: []string{"system-admin-readonly"}})
	if err != nil || role != identity.RoleSystemAdminReadonly {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "deny") != deny+1 || metric("sessions", "allow") != allow+1 {
		t.Fatal("readonly is a denied delete and an allowed list")
	}
}

func TestPlatformRoleDefaultMayNeither(t *testing.T) {
	deny := metric("sessions", "deny")
	c := NewClient(verbReviewer{}, "primus:")
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-1"})
	if err != nil || role != identity.RoleDefault {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "deny") != deny+2 {
		t.Fatal("a default user is denied both delete and list")
	}
}

func TestPlatformRoleReviewErrorIsUnavailable(t *testing.T) {
	before := metric("sessions", "unavailable")
	c := NewClient(verbReviewer{err: errors.New("apiserver down")}, "primus:")
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-1"})
	if err == nil || !errors.Is(err, ErrUnavailable) || role != "" {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "unavailable") != before+1 {
		t.Fatal("a failed review was not counted separately from a denial")
	}
}

func TestFromClientsetRejectsAnEmptyPrefix(t *testing.T) {
	t.Setenv(PrefixEnv, " ")
	if _, err := FromClientset(k8sfake.NewSimpleClientset()); err == nil {
		t.Fatal("empty RBAC_SUBJECT_PREFIX was accepted")
	}
	t.Setenv(PrefixEnv, "primus:")
	if c, err := FromClientset(k8sfake.NewSimpleClientset()); err != nil || c.prefix != "primus:" {
		t.Fatalf("client = %+v, %v", c, err)
	}
}

// recordingReviewer keeps the last SubjectAccessReviewSpec.
type recordingReviewer struct {
	spec  authorizationv1.SubjectAccessReviewSpec
	calls int
}

func (r *recordingReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	r.calls++
	r.spec = sar.Spec
	out := sar.DeepCopy()
	out.Status.Allowed = true
	return out, nil
}

func TestWorkspaceUseReviewSpec(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	tok := identity.Token{Subject: "u-1", Roles: []string{"system-admin"}, Groups: []string{"b", "", "a"}}
	ok, err := c.CanUseWorkspace(context.Background(), tok, "lab")
	if err != nil || !ok {
		t.Fatalf("allowed=%v err=%v", ok, err)
	}
	want := authorizationv1.SubjectAccessReviewSpec{
		User:   "primus:u-1",
		Groups: []string{"primus:a", "primus:b"},
		ResourceAttributes: &authorizationv1.ResourceAttributes{
			Group: "amd.com", Resource: "workspaces", Verb: "use", Name: "lab",
		},
	}
	if !reflect.DeepEqual(rec.spec, want) {
		t.Fatalf("spec = %#v", rec.spec)
	}
}

func TestCanUseWorkspaceRejectsAnEmptyName(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	ok, err := c.CanUseWorkspace(context.Background(), identity.Token{Subject: "u-1"}, "")
	if ok || !errors.Is(err, ErrEmptyWorkspace) || rec.calls != 0 {
		t.Fatalf("allowed=%v err=%v calls=%d", ok, err, rec.calls)
	}
}

func TestCanUseAllWorkspacesReviewsAnEmptyName(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	ok, err := c.CanUseAllWorkspaces(context.Background(), identity.Token{Subject: "u-1", Groups: []string{"team"}})
	if err != nil || !ok || rec.spec.ResourceAttributes == nil || rec.spec.ResourceAttributes.Name != "" || rec.spec.User != "primus:u-1" {
		t.Fatalf("allowed=%v err=%v spec=%#v", ok, err, rec.spec)
	}
}

func TestChooseWorkspaceRequiresAName(t *testing.T) {
	c := NewClient(&recordingReviewer{}, "primus:")
	if _, err := c.ChooseWorkspace(context.Background(), identity.Token{Subject: "u-1"}, ""); !errors.Is(err, ErrWorkspaceRequired) {
		t.Fatalf("err=%v", err)
	}
}

// countingReviewer allows every review, counts calls, and fails while err is set.
type countingReviewer struct {
	mu    sync.Mutex
	calls int
	err   error
	gate  chan struct{}
}

func (r *countingReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	r.mu.Lock()
	r.calls++
	err := r.err
	r.mu.Unlock()
	if r.gate != nil {
		<-r.gate
	}
	if err != nil {
		return nil, err
	}
	out := sar.DeepCopy()
	out.Status.Allowed = sar.Spec.ResourceAttributes.Name != "denied"
	return out, nil
}

func (r *countingReviewer) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func TestAllowedCachesAllowFor30sAndDenyFor5s(t *testing.T) {
	rec := &countingReviewer{}
	c := NewClient(rec, "primus:")
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }
	ctx := context.Background()
	tok := identity.Token{Subject: "u-1"}

	for _, ws := range []string{"lab", "denied"} {
		if _, err := c.CanUseWorkspace(ctx, tok, ws); err != nil {
			t.Fatal(err)
		}
	}
	if rec.count() != 2 {
		t.Fatalf("calls=%d", rec.count())
	}
	now = now.Add(denyTTL - time.Second)
	_, _ = c.CanUseWorkspace(ctx, tok, "lab")
	_, _ = c.CanUseWorkspace(ctx, tok, "denied")
	if rec.count() != 2 {
		t.Fatalf("both answers are cached before the deny TTL: calls=%d", rec.count())
	}
	now = now.Add(time.Second)
	if ok, _ := c.CanUseWorkspace(ctx, tok, "denied"); ok || rec.count() != 3 {
		t.Fatalf("a deny is asked again after its TTL: ok=%v calls=%d", ok, rec.count())
	}
	if _, _ = c.CanUseWorkspace(ctx, tok, "lab"); rec.count() != 3 {
		t.Fatalf("an allow is still cached: calls=%d", rec.count())
	}
	now = now.Add(allowTTL)
	if ok, _ := c.CanUseWorkspace(ctx, tok, "lab"); !ok || rec.count() != 4 {
		t.Fatalf("an allow is asked again after its TTL: ok=%v calls=%d", ok, rec.count())
	}
}

func TestAllowedDoesNotCacheAnUnavailableReview(t *testing.T) {
	rec := &countingReviewer{err: errors.New("apiserver down")}
	c := NewClient(rec, "primus:")
	ctx := context.Background()
	tok := identity.Token{Subject: "u-1"}
	if _, err := c.CanUseWorkspace(ctx, tok, "lab"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err=%v", err)
	}
	rec.mu.Lock()
	rec.err = nil
	rec.mu.Unlock()
	if ok, err := c.CanUseWorkspace(ctx, tok, "lab"); err != nil || !ok || rec.count() != 2 {
		t.Fatalf("ok=%v err=%v calls=%d", ok, err, rec.count())
	}
}

func TestAllowedSharesOneCallAcrossConcurrentCallers(t *testing.T) {
	rec := &countingReviewer{gate: make(chan struct{})}
	c := NewClient(rec, "primus:")
	tok := identity.Token{Subject: "u-1", Groups: []string{"team"}}
	const callers = 8
	var wg sync.WaitGroup
	results := make(chan bool, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _ := c.CanUseWorkspace(context.Background(), tok, "lab")
			results <- ok
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for rec.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(rec.gate)
	wg.Wait()
	close(results)
	for ok := range results {
		if !ok {
			t.Fatal("a caller did not get the shared answer")
		}
	}
	if rec.count() != 1 {
		t.Fatalf("calls=%d", rec.count())
	}
}

func TestAllowedDeniesAnEmptySubjectWithoutAReview(t *testing.T) {
	rec := &countingReviewer{}
	c := NewClient(rec, "primus:")
	ok, err := c.Allowed(context.Background(), "", []string{"system-admin"}, workspaceUse("lab"))
	if ok || err != nil || rec.count() != 0 {
		t.Fatalf("ok=%v err=%v calls=%d", ok, err, rec.count())
	}
}

// teamReviewer allows a review only when the subject groups include the group required for resource/verb.
type teamReviewer struct {
	need map[string]string
}

// Create answers one review from the required group of its resource and verb.
func (r teamReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	out := sar.DeepCopy()
	attrs := sar.Spec.ResourceAttributes
	want, ok := r.need[attrs.Resource+"/"+attrs.Verb]
	out.Status.Allowed = ok && slices.Contains(sar.Spec.Groups, want)
	return out, nil
}

// TestReviewGroups checks how team ids become review groups.
func TestReviewGroups(t *testing.T) {
	tests := []struct {
		name string
		tok  identity.Token
		want []string
	}{
		{name: "no teams", tok: identity.Token{Groups: []string{"g1"}}, want: []string{"g1"}},
		{name: "nothing", tok: identity.Token{}, want: nil},
		{name: "prefixed", tok: identity.Token{Teams: []string{"a", "b"}}, want: []string{"team:a", "team:b"}},
		{name: "empty id skipped", tok: identity.Token{Teams: []string{"", "a"}}, want: []string{"team:a"}},
		{name: "colon id skipped", tok: identity.Token{Teams: []string{"x:y", ":", "a"}}, want: []string{"team:a"}},
		{name: "groups and teams", tok: identity.Token{Groups: []string{"g1"}, Teams: []string{"a"}}, want: []string{"g1", "team:a"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := reviewGroups(tc.tok); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("groups = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestReviewGroupsDoesNotMutateTheToken checks that appending teams leaves the token slices intact.
func TestReviewGroupsDoesNotMutateTheToken(t *testing.T) {
	groups := make([]string, 1, 8)
	groups[0] = "g1"
	tok := identity.Token{Groups: groups, Teams: []string{"a"}}
	_ = reviewGroups(tok)
	if !reflect.DeepEqual(tok.Groups, []string{"g1"}) || !reflect.DeepEqual(tok.Teams, []string{"a"}) || groups[:2][1] != "" {
		t.Fatalf("token changed: %#v backing=%#v", tok, groups[:2])
	}
}

// TestReviewSpecGroupsAreTeamAwareSortedAndCompacted checks the prefixed, sorted and de-duplicated review groups.
func TestReviewSpecGroupsAreTeamAwareSortedAndCompacted(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	tok := identity.Token{Subject: "u-1", Groups: []string{"team:a", "z", "g1"}, Teams: []string{"b", "a", "a", "", "x:y"}}
	if _, err := c.CanUseWorkspace(context.Background(), tok, "lab"); err != nil {
		t.Fatal(err)
	}
	want := []string{"primus:g1", "primus:team:a", "primus:team:b", "primus:z"}
	if !reflect.DeepEqual(rec.spec.Groups, want) {
		t.Fatalf("groups = %#v, want %#v", rec.spec.Groups, want)
	}
}

// TestTeamGroupGrantsAccess checks that a team group is the only access path for each decision.
func TestTeamGroupGrantsAccess(t *testing.T) {
	r := teamReviewer{need: map[string]string{
		"workspaces/use":  "primus:team:a",
		"sessions/delete": "primus:team:adm",
		"sessions/list":   "primus:team:aud",
	}}
	tests := []struct {
		name      string
		teams     []string
		workspace bool
		role      string
	}{
		{name: "no team", teams: nil, role: identity.RoleDefault},
		{name: "other team", teams: []string{"b"}, role: identity.RoleDefault},
		{name: "workspace team", teams: []string{"a"}, workspace: true, role: identity.RoleDefault},
		{name: "admin team", teams: []string{"adm"}, role: identity.RoleSystemAdmin},
		{name: "audit team", teams: []string{"aud"}, role: identity.RoleSystemAdminReadonly},
		{name: "invalid id never matches", teams: []string{"x:a"}, role: identity.RoleDefault},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := NewClient(r, "primus:")
			ctx := context.Background()
			tok := identity.Token{Subject: "u-1", Teams: tc.teams}
			if ok, err := c.CanUseWorkspace(ctx, tok, "lab"); err != nil || ok != tc.workspace {
				t.Fatalf("CanUseWorkspace = %v, %v", ok, err)
			}
			if ok, err := c.CanUseAllWorkspaces(ctx, tok); err != nil || ok != tc.workspace {
				t.Fatalf("CanUseAllWorkspaces = %v, %v", ok, err)
			}
			if role, err := c.PlatformRole(ctx, tok); err != nil || role != tc.role {
				t.Fatalf("PlatformRole = %q, %v", role, err)
			}
		})
	}
}
