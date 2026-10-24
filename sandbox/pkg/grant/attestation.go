// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	attestationIssuer   = "primus-claw"
	attestationAudience = "agent-sandbox-workload"
)

// grantClaims is the Claw attestation verified at issue time and later by OPA.
type grantClaims struct {
	jwt.RegisteredClaims
	Workspaces        []string `json:"workspaces"`
	Kinds             []string `json:"kinds"`
	MaxGPUsPerSandbox int      `json:"maxGpusPerSandbox"`
}

// AttestationChecker verifies a Claw-signed grant JWT.
type AttestationChecker interface {
	// Check reports whether token authorizes req.
	Check(token string, req IssueRequest) error
}

// JWKSChecker verifies ES256 attestations against a JWKS document.
type JWKSChecker struct {
	keys map[string]*ecdsa.PublicKey
}

// NewJWKSChecker parses a JWKS document containing P-256 keys.
func NewJWKSChecker(jwks []byte) (*JWKSChecker, error) {
	var doc struct {
		Keys []struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			Kid string `json:"kid"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(jwks, &doc); err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	keys := make(map[string]*ecdsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" || k.Kid == "" {
			continue
		}
		pub, err := p256FromXY(k.X, k.Y)
		if err != nil {
			return nil, fmt.Errorf("jwks key %s: %w", k.Kid, err)
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("jwks contains no P-256 keys")
	}
	return &JWKSChecker{keys: keys}, nil
}

// Check verifies signature, issuer, audience, expiry, and the claims that must
// match the issue request.
func (c *JWKSChecker) Check(token string, req IssueRequest) error {
	claims := &grantClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodES256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		pub := c.keys[kid]
		if pub == nil {
			return nil, fmt.Errorf("unknown kid")
		}
		return pub, nil
	}, jwt.WithIssuer(attestationIssuer), jwt.WithAudience(attestationAudience), jwt.WithExpirationRequired())
	if err != nil {
		return opErr(http.StatusBadRequest, "attestation_invalid", err.Error())
	}
	if !parsed.Valid {
		return opErr(http.StatusBadRequest, "attestation_invalid", "token is not valid")
	}
	if claims.ID != req.GrantID {
		return opErr(http.StatusBadRequest, "attestation_invalid", "jti does not match grantId")
	}
	if claims.Subject != req.Owner.UserID {
		return opErr(http.StatusBadRequest, "attestation_invalid", "sub does not match owner.userId")
	}
	if claims.ExpiresAt == nil || !sameExpiry(claims.ExpiresAt.Time, req.ExpiresAt) {
		return opErr(http.StatusBadRequest, "attestation_invalid", "exp does not match expiresAt")
	}
	for _, ws := range req.Owner.Workspaces {
		if !contains(claims.Workspaces, ws) {
			return opErr(http.StatusBadRequest, "attestation_invalid", "workspace is not in the attestation")
		}
	}
	return nil
}

func p256FromXY(xB64, yB64 string) (*ecdsa.PublicKey, error) {
	x, err := base64.RawURLEncoding.DecodeString(xB64)
	if err != nil {
		return nil, fmt.Errorf("x: %w", err)
	}
	y, err := base64.RawURLEncoding.DecodeString(yB64)
	if err != nil {
		return nil, fmt.Errorf("y: %w", err)
	}
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(x),
		Y:     new(big.Int).SetBytes(y),
	}, nil
}

func sameExpiry(a, b time.Time) bool {
	return a.UTC().Truncate(time.Second).Equal(b.UTC().Truncate(time.Second))
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
