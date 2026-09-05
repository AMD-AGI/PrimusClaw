// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Router → EnvD internal JWT signing (RSA-256).
package router

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	rsaKeySize    = 2048
	jwtExpiration = 5 * time.Minute
	jwtIssuer     = "agent-sandbox-router"
	jwtAudience   = "agent-sandbox-envd"

	// IdentitySecretName is the K8s Secret that stores the Router's RSA key pair.
	IdentitySecretName = "envd-router-identity" //nolint:gosec // name reference, not credential
	PrivateKeyDataKey  = "private.pem"
	PublicKeyDataKey   = "public.pem"
)

// IdentityNamespace is read from AGENT_SANDBOX_NAMESPACE env var.
// Falls back to "agent-sandbox-system" which is the default deployment namespace.
var IdentityNamespace = "agent-sandbox-system"

// identityReconcileBudget bounds EnsureJWTIdentity end to end: backoff and API
// calls together, not one of them at a time.
//
// The Router registers no routes until this returns, so the whole budget is
// spent with nothing listening on the router port -- while the startupProbe is
// already counting down. deploy/*/controlplane.yaml allows failureThreshold 30
// * periodSeconds 2 = 60s of that, shared with everything else before
// router.New. Bounding the attempt count and the per-request timeout
// separately made the worst case their product (6 attempts * a Get plus a
// Create * 5s, on top of 30s of backoff) which overran the window: the kubelet
// killed the container partway through, discarding the very retries it was
// waiting on, and reported "startup probe failed" in place of the real cause.
// Worse, router.New failing exits the process, and Workload Manager shares it.
//
// One deadline keeps the worst case equal to the number written here. The
// share this can claim is what is left of the window after the work that runs
// first -- CRD informer cache sync above all, which carries a timeout of its
// own -- so it is sized against that remainder rather than against the window,
// and stays small enough that startup fits without the probe being widened.
// Overridden in tests.
var identityReconcileBudget = 15 * time.Second

// identityRetryDelay is the base delay between reconcile attempts; attempt N
// waits (N-1) * identityRetryDelay. A 500ms base spent everything in ~5s,
// shorter than the disruption it exists to ride out, so the retries expired
// and the "transient" path became a crash. Overridden in tests.
var identityRetryDelay = 2 * time.Second

// Bound each Kubernetes request independently so a wedged API connection
// cannot hang process startup or shutdown forever.
//
// Small relative to the budget on purpose: against an apiserver that hangs
// rather than refuses, this is what each attempt costs, so a timeout close to
// the budget would spend it on one or two attempts and turn the retry loop
// into a single try. Overridden in tests.
var identityRequestTimeout = 3 * time.Second

func init() {
	if ns := os.Getenv("AGENT_SANDBOX_NAMESPACE"); ns != "" {
		IdentityNamespace = ns
	}
}

// JWTManager handles RSA key pair lifecycle and JWT signing for the Router.
type JWTManager struct {
	privateKey *rsa.PrivateKey
	publicKey  *rsa.PublicKey
	clientset  kubernetes.Interface
}

// NewJWTManager generates a fresh RSA-2048 key pair. The caller supplies the
// client because the unified control plane may run either in-cluster or
// against a kubeconfig, and identity reconciliation must not guess which.
// Callers with no cluster to reach pass nil and get a signing-only manager.
func NewJWTManager(clientset kubernetes.Interface) (*JWTManager, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, rsaKeySize)
	if err != nil {
		return nil, fmt.Errorf("failed to generate RSA key pair: %w", err)
	}
	return &JWTManager{
		privateKey: privateKey,
		publicKey:  &privateKey.PublicKey,
		clientset:  clientset,
	}, nil
}

// GenerateToken signs a JWT with session_id claim (5min TTL).
func (jm *JWTManager) GenerateToken(sessionID string) (string, error) {
	if jm == nil || jm.privateKey == nil {
		return "", fmt.Errorf("JWT private key is unavailable")
	}
	if err := jm.privateKey.Validate(); err != nil {
		return "", fmt.Errorf("invalid JWT private key: %w", err)
	}
	claims := jwt.MapClaims{
		"iss":        jwtIssuer,
		"aud":        jwtAudience,
		"iat":        time.Now().Unix(),
		"exp":        time.Now().Add(jwtExpiration).Unix(),
		"session_id": sessionID,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	return token.SignedString(jm.privateKey)
}

// GetPublicKeyPEM returns the public key in PEM format (injected into EnvD env).
func (jm *JWTManager) GetPublicKeyPEM() ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(jm.publicKey)
	if err != nil {
		return nil, fmt.Errorf("marshal public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

// GetPrivateKeyPEM returns the private key in PEM format.
func (jm *JWTManager) GetPrivateKeyPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(jm.privateKey),
	})
}

// identitySecret renders this process's key pair as the Router identity Secret.
func (jm *JWTManager) identitySecret() (*corev1.Secret, error) {
	pubPEM, err := jm.GetPublicKeyPEM()
	if err != nil {
		return nil, fmt.Errorf("get public key PEM: %w", err)
	}
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      IdentitySecretName,
			Namespace: IdentityNamespace,
			Labels: map[string]string{
				"app":       "agent-sandbox",
				"component": "router",
			},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			PrivateKeyDataKey: jm.GetPrivateKeyPEM(),
			PublicKeyDataKey:  pubPEM,
		},
	}, nil
}

// EnsureJWTIdentity reconciles this process's key pair with the cluster's
// persisted Router identity, so that jm.privateKey ends up being the
// counterpart of the public key Workload Manager injects into every sandbox
// Pod as ENVD_AUTH_PUBLIC_KEY (it reads that from this same Secret).
//
// Any other outcome is unserviceable rather than degraded: EnvD verifies every
// exec against the injected key, so a Router holding a different key fails
// 100% of sandboxExec calls with 401 until the process restarts. That is why
// the Secret is read first and only created when genuinely absent, and why a
// transient API error is retried instead of being allowed to fall through --
// an unreachable API server used to leave the Router signing with the
// throwaway key from NewJWTManager for hours.
//
// The caller supplies the same Kubernetes client used by the rest of the
// control plane. This is required even out of cluster: controller-runtime may
// be using a kubeconfig, where InClusterConfig is unavailable but sandboxes
// still verify against the cluster Secret.
func (jm *JWTManager) EnsureJWTIdentity(ctx context.Context) error {
	if jm.clientset == nil {
		return fmt.Errorf("kubernetes client is required to reconcile JWT identity")
	}

	ctx, cancel := context.WithTimeout(ctx, identityReconcileBudget)
	defer cancel()

	secrets := jm.clientset.CoreV1().Secrets(IdentityNamespace)
	var lastErr error
	for attempt := 1; ; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("JWT identity not reconciled within %s (%d attempts): %w",
					identityReconcileBudget, attempt-1, errors.Join(ctx.Err(), lastErr))
			case <-time.After(time.Duration(attempt-1) * identityRetryDelay):
			}
		}

		requestCtx, cancel := context.WithTimeout(ctx, identityRequestTimeout)
		existing, err := secrets.Get(requestCtx, IdentitySecretName, metav1.GetOptions{})
		cancel()
		if err == nil {
			privPEM, ok := existing.Data[PrivateKeyDataKey]
			if !ok || len(privPEM) == 0 {
				return fmt.Errorf("private key %q not found in secret %s/%s",
					PrivateKeyDataKey, IdentityNamespace, IdentitySecretName)
			}
			// Unparseable material will not repair itself, so surface it now
			// instead of spending the remaining attempts on it.
			if err := jm.loadPrivateKeyPEM(privPEM); err != nil {
				return fmt.Errorf("load private key from secret %s/%s: %w",
					IdentityNamespace, IdentitySecretName, err)
			}
			pubPEM, ok := existing.Data[PublicKeyDataKey]
			if !ok || len(pubPEM) == 0 {
				return fmt.Errorf("public key %q not found in secret %s/%s",
					PublicKeyDataKey, IdentityNamespace, IdentitySecretName)
			}
			storedPublicKey, err := parsePublicKeyPEM(pubPEM)
			if err != nil {
				return fmt.Errorf("load public key from secret %s/%s: %w",
					IdentityNamespace, IdentitySecretName, err)
			}
			if !jm.publicKey.Equal(storedPublicKey) {
				return fmt.Errorf("public and private keys do not match in secret %s/%s",
					IdentityNamespace, IdentitySecretName)
			}
			log.Infof("Loaded JWT identity from existing secret %s/%s", IdentityNamespace, IdentitySecretName)
			return nil
		}
		if !apierrors.IsNotFound(err) {
			lastErr = fmt.Errorf("get identity secret: %w", err)
			log.Warnf("JWT identity read failed (attempt %d): %v", attempt, err)
			continue
		}

		secret, err := jm.identitySecret()
		if err != nil {
			return err
		}
		requestCtx, cancel = context.WithTimeout(ctx, identityRequestTimeout)
		_, err = secrets.Create(requestCtx, secret, metav1.CreateOptions{})
		cancel()
		if err != nil {
			// AlreadyExists is deliberately retried rather than special-cased:
			// another replica won the race, and the next attempt's Get adopts
			// the winner's key instead of keeping ours.
			lastErr = fmt.Errorf("create identity secret: %w", err)
			log.Warnf("JWT identity create failed (attempt %d): %v", attempt, err)
			continue
		}
		log.Infof("Created JWT identity secret %s/%s", IdentityNamespace, IdentitySecretName)
		return nil
	}
}

func (jm *JWTManager) loadPrivateKeyPEM(pemBytes []byte) error {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return fmt.Errorf("failed to decode private key PEM")
	}
	key, err := parseRSAPrivateKey(block.Bytes)
	if err != nil {
		return err
	}
	jm.privateKey = key
	jm.publicKey = &key.PublicKey
	return nil
}

// parseRSAPrivateKey accepts both encodings openssl emits, because rejecting
// one of them costs the whole control plane. Unparseable key material is
// deliberately not retried, so it exits the process -- and Workload Manager
// shares that process. Accepting only PKCS#1 meant a Secret generated by
// `openssl genrsa` under OpenSSL 3.x, which writes PKCS#8 by default, took the
// cluster's ability to create sandboxes down with the Router.
func parseRSAPrivateKey(der []byte) (*rsa.PrivateKey, error) {
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse private key: not a PKCS#1 or PKCS#8 RSA key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("parse private key: PKCS#8 key is %T, not *rsa.PrivateKey", parsed)
	}
	return key, nil
}

func parsePublicKeyPEM(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("failed to decode public key PEM")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	rsaKey, ok := key.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is %T, not *rsa.PublicKey", key)
	}
	return rsaKey, nil
}
