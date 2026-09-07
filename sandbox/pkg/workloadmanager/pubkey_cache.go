// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	// RouterIdentitySecretName is the name of the Secret storing the Router's RSA key pair.
	RouterIdentitySecretName = "envd-router-identity"
	// PublicKeyDataKey is the key in the Secret data map for the public key PEM.
	PublicKeyDataKey = "public.pem"
)

// routerIdentityNamespace is read from AGENT_SANDBOX_NAMESPACE env var.
var routerIdentityNamespace = func() string {
	if ns := os.Getenv("AGENT_SANDBOX_NAMESPACE"); ns != "" {
		return ns
	}
	return "agent-sandbox-system"
}()

var (
	cachedPublicKeyPEM string
	cachedRSAPublicKey *rsa.PublicKey
	publicKeyCacheMu   sync.RWMutex
)

// GetCachedPublicKey returns the cached Router RSA public key PEM, or empty string if not yet loaded.
func GetCachedPublicKey() string {
	publicKeyCacheMu.RLock()
	defer publicKeyCacheMu.RUnlock()
	return cachedPublicKeyPEM
}

// GetCachedRSAPublicKey returns the cached parsed RSA public key, or nil if not yet loaded.
func GetCachedRSAPublicKey() *rsa.PublicKey {
	publicKeyCacheMu.RLock()
	defer publicKeyCacheMu.RUnlock()
	return cachedRSAPublicKey
}

// IsPublicKeyCached returns true if the public key has been successfully loaded from the Secret.
func IsPublicKeyCached() bool {
	publicKeyCacheMu.RLock()
	defer publicKeyCacheMu.RUnlock()
	return cachedPublicKeyPEM != ""
}

// InitPublicKeyCache starts a background goroutine that loads the Router's public key
// from the K8s Secret, retrying with exponential backoff until successful or ctx is cancelled.
// This handles the case where Router hasn't started yet when WorkloadManager starts.
func InitPublicKeyCache(ctx context.Context, clientset kubernetes.Interface) {
	go func() {
		backoff := 200 * time.Millisecond
		for {
			if err := loadPublicKeyFromSecret(clientset); err == nil {
				log.Info("loaded Router public key from secret",
					"namespace", routerIdentityNamespace,
					"secret", RouterIdentitySecretName)
				return
			} else {
				log.Debug("waiting for Router public key",
					"secret", RouterIdentitySecretName,
					"retry_in", backoff,
					"error", err)
			}
			select {
			case <-ctx.Done():
				log.Warn("public key cache init cancelled", "error", ctx.Err())
				return
			case <-time.After(backoff):
			}
			if backoff < 10*time.Second {
				backoff *= 2
			}
		}
	}()
}

// loadPublicKeyFromSecret reads the RSA public key from the Router identity Secret.
func loadPublicKeyFromSecret(clientset kubernetes.Interface) error {
	secret, err := clientset.CoreV1().Secrets(routerIdentityNamespace).Get(
		context.Background(),
		RouterIdentitySecretName,
		metav1.GetOptions{},
	)
	if err != nil {
		return fmt.Errorf("get secret %s/%s: %w", routerIdentityNamespace, RouterIdentitySecretName, err)
	}

	data, ok := secret.Data[PublicKeyDataKey]
	if !ok || len(data) == 0 {
		return fmt.Errorf("key %q not found in secret %s/%s",
			PublicKeyDataKey, routerIdentityNamespace, RouterIdentitySecretName)
	}

	rsaPub, err := parseRSAPublicKey(data)
	if err != nil {
		return fmt.Errorf("parse public key from secret %s/%s: %w",
			routerIdentityNamespace, RouterIdentitySecretName, err)
	}

	publicKeyCacheMu.Lock()
	cachedPublicKeyPEM = string(data)
	cachedRSAPublicKey = rsaPub
	publicKeyCacheMu.Unlock()
	return nil
}

func parseRSAPublicKey(pemData []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("no PEM block found")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("ParsePKIXPublicKey: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("key is %T, not *rsa.PublicKey", pub)
	}
	return rsaPub, nil
}
