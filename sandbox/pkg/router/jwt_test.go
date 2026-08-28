// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/agent-sandbox/pkg/workloadmanager"
)

// shrinkIdentityRetryDelay keeps the retry-path tests instant. The budget goes
// with the delay: it is what ends the loop now, so leaving it at its real
// value would make every give-up test wait that long.
func shrinkIdentityRetryDelay(t *testing.T) {
	t.Helper()
	prevDelay, prevBudget := identityRetryDelay, identityReconcileBudget
	identityRetryDelay = time.Millisecond
	identityReconcileBudget = 50 * time.Millisecond
	t.Cleanup(func() {
		identityRetryDelay, identityReconcileBudget = prevDelay, prevBudget
	})
}

// The reconcile runs before the Router listens, so its budget is spent against
// the startupProbe's countdown. Both ends matter: too short and a routine
// apiserver rollout becomes a crash, too long and the kubelet kills the
// container before the retries it was killed for can finish -- taking Workload
// Manager, which shares the process, down with it.
func TestIdentityReconcileBudgetFitsTheStartupWindow(t *testing.T) {
	// deploy/{k8s,k8s-kata,helm/templates}/controlplane.yaml all set the router
	// startupProbe to failureThreshold 30 * periodSeconds 2.
	const startupWindow = 60 * time.Second
	// What the window has to cover before router.New. The CRD informer sync
	// dominates and enforces its own timeout, so it is read from there rather
	// than guessed: a figure written out here would keep this test green while
	// the sync quietly grew past the window on its own.
	const otherStartupWork = 10 * time.Second
	restOfStartup := workloadmanager.CRDCacheSyncTimeout + otherStartupWork

	// The lower bound is what the retry loop is for, expressed as the thing it
	// has to survive rather than as a round number: an apiserver that hangs
	// costs a full request timeout per attempt, so the budget has to hold
	// several of those plus the backoff between them, or the loop degrades to
	// a single try and a transient failure becomes a crash.
	const minAttempts = 3
	var backoff time.Duration
	for attempt := 1; attempt < minAttempts; attempt++ {
		backoff += time.Duration(attempt) * identityRetryDelay
	}
	assert.GreaterOrEqual(t, identityReconcileBudget, minAttempts*identityRequestTimeout+backoff,
		"budget of %s cannot hold %d attempts against a hanging apiserver (%s each plus %s of backoff)",
		identityReconcileBudget, minAttempts, identityRequestTimeout, backoff)
	assert.LessOrEqual(t, identityReconcileBudget+restOfStartup, startupWindow,
		"budget of %s plus %s of other startup work overruns the %s startup window, so the kubelet kills the container mid-retry",
		identityReconcileBudget, restOfStartup, startupWindow)
}

// The budget, not an attempt count, is what ends the loop -- which is the
// whole point of it: with attempts and per-request timeouts bounded separately
// the worst case was their product, and no single number said when startup
// would give up.
func TestEnsureJWTIdentityGivesUpAtItsBudget(t *testing.T) {
	prev := identityReconcileBudget
	identityReconcileBudget = 100 * time.Millisecond
	t.Cleanup(func() { identityReconcileBudget = prev })

	cs := fake.NewClientset()
	cs.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, connectionReset()
	})

	jm, err := NewJWTManager(cs)
	require.NoError(t, err)

	started := time.Now()
	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Less(t, time.Since(started), 10*identityReconcileBudget,
		"the deadline must end the loop; nothing else bounds it")
}

// persistedIdentity returns a manager standing in for whoever created the
// Secret first, plus the Secret itself.
func persistedIdentity(t *testing.T) (*JWTManager, *corev1.Secret) {
	t.Helper()
	owner, err := NewJWTManager(nil)
	require.NoError(t, err)
	secret, err := owner.identitySecret()
	require.NoError(t, err)
	return owner, secret
}

func connectionReset() error {
	return errors.New("read tcp 172.16.26.7:49808->192.168.0.1:443: read: connection reset by peer")
}

func TestEnsureJWTIdentityAdoptsPersistedKey(t *testing.T) {
	owner, secret := persistedIdentity(t)

	jm, err := NewJWTManager(fake.NewClientset(secret))
	require.NoError(t, err)

	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))
	assert.True(t, jm.publicKey.Equal(owner.publicKey),
		"must sign with the persisted key, not the one generated at startup")
}

// A transient API error is the exact shape of the 2026-08-06 incident: the
// create call failed at the network layer, which is neither NotFound nor
// AlreadyExists. The old code treated that as fatal-but-ignorable and left the
// Router signing with its throwaway key, so every sandboxExec returned 401
// until the pod restarted. Reading must be retried instead.
func TestEnsureJWTIdentityRetriesTransientReadFailure(t *testing.T) {
	shrinkIdentityRetryDelay(t)
	owner, secret := persistedIdentity(t)

	cs := fake.NewClientset(secret)
	var gets atomic.Int32
	cs.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		if gets.Add(1) == 1 {
			return true, nil, connectionReset()
		}
		return false, nil, nil
	})

	jm, err := NewJWTManager(cs)
	require.NoError(t, err)

	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))
	assert.True(t, jm.publicKey.Equal(owner.publicKey),
		"a retryable error must not leave the generated key in place")
}

// When the identity can never be read the manager must report failure, so the
// caller refuses to start rather than serving tokens nothing can verify.
func TestEnsureJWTIdentityFailsWhenSecretUnreadable(t *testing.T) {
	shrinkIdentityRetryDelay(t)

	cs := fake.NewClientset()
	cs.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, connectionReset()
	})

	jm, err := NewJWTManager(cs)
	require.NoError(t, err)

	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not reconciled")
}

func TestEnsureJWTIdentityCreatesWhenAbsent(t *testing.T) {
	cs := fake.NewClientset()

	jm, err := NewJWTManager(cs)
	require.NoError(t, err)

	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))

	stored, err := cs.CoreV1().Secrets(IdentityNamespace).
		Get(context.Background(), IdentitySecretName, metav1.GetOptions{})
	require.NoError(t, err)
	own, err := jm.GetPublicKeyPEM()
	require.NoError(t, err)
	assert.Equal(t, string(own), string(stored.Data[PublicKeyDataKey]),
		"the stored public half must match the key we sign with")
	require.NoError(t, jm.loadPrivateKeyPEM(stored.Data[PrivateKeyDataKey]),
		"the stored private half must be loadable by the next replica")
}

// Losing the create race must adopt the winner's key rather than keeping ours,
// otherwise two replicas sign with different keys and one of them is invalid
// for every sandbox in the cluster.
func TestEnsureJWTIdentityAdoptsWinnerOnCreateRace(t *testing.T) {
	shrinkIdentityRetryDelay(t)
	winner, secret := persistedIdentity(t)

	cs := fake.NewClientset(secret)
	var gets atomic.Int32
	cs.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		if gets.Add(1) == 1 {
			return true, nil, apierrors.NewNotFound(corev1.Resource("secrets"), IdentitySecretName)
		}
		return false, nil, nil
	})
	cs.PrependReactor("create", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewAlreadyExists(corev1.Resource("secrets"), IdentitySecretName)
	})

	jm, err := NewJWTManager(cs)
	require.NoError(t, err)

	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))
	assert.True(t, jm.publicKey.Equal(winner.publicKey))
}

// `openssl genrsa` writes PKCS#8 under OpenSSL 3.x, so a hand-made Secret is
// as likely to hold that as PKCS#1. Rejecting it is not a Router-local
// failure: the load error is deliberately not retried, so the process exits
// and takes Workload Manager -- and the cluster's ability to create sandboxes
// at all -- with it.
func TestEnsureJWTIdentityAcceptsPKCS8PrivateKey(t *testing.T) {
	owner, secret := persistedIdentity(t)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(owner.privateKey)
	require.NoError(t, err)
	secret.Data[PrivateKeyDataKey] = pem.EncodeToMemory(
		&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})

	jm, err := NewJWTManager(fake.NewClientset(secret))
	require.NoError(t, err)

	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))
	assert.True(t, jm.publicKey.Equal(owner.publicKey),
		"a PKCS#8 Secret must yield the same identity as the PKCS#1 encoding of it")
}

// Corrupt material will not repair itself, so it must surface immediately
// instead of consuming the retry budget.
func TestEnsureJWTIdentityRejectsUnparseablePrivateKey(t *testing.T) {
	_, secret := persistedIdentity(t)
	secret.Data[PrivateKeyDataKey] = []byte("-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----\n")

	jm, err := NewJWTManager(fake.NewClientset(secret))
	require.NoError(t, err)

	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load private key")
}

func TestEnsureJWTIdentityRequiresKubernetesClient(t *testing.T) {
	jm, err := NewJWTManager(nil)
	require.NoError(t, err)

	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "kubernetes client is required")
}

func TestEnsureJWTIdentityRejectsMissingPublicKey(t *testing.T) {
	_, secret := persistedIdentity(t)
	delete(secret.Data, PublicKeyDataKey)

	jm, err := NewJWTManager(fake.NewClientset(secret))
	require.NoError(t, err)

	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "public key")
}

func TestEnsureJWTIdentityRejectsMismatchedKeyPair(t *testing.T) {
	_, secret := persistedIdentity(t)
	other, err := NewJWTManager(nil)
	require.NoError(t, err)
	otherPublic, err := other.GetPublicKeyPEM()
	require.NoError(t, err)
	secret.Data[PublicKeyDataKey] = otherPublic

	jm, err := NewJWTManager(fake.NewClientset(secret))
	require.NoError(t, err)

	err = jm.EnsureJWTIdentity(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "do not match")
}

func TestEnsureJWTIdentityStopsWhenStartupContextIsCancelled(t *testing.T) {
	cs := fake.NewClientset()
	cs.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, connectionReset()
	})
	jm, err := NewJWTManager(cs)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := time.Now()
	err = jm.EnsureJWTIdentity(ctx)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Less(t, time.Since(started), 250*time.Millisecond)
}
