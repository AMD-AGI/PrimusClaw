// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package store provides session→sandbox state storage.
// Supported backends: memory (dev), redis (production).
package store

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// redisConnectMaxAttempts caps the number of build-time connection attempts
// before falling back to the in-memory store. Each attempt has its own
// 2s Ping timeout (see NewRedisStore), and we sleep a fixed interval between
// attempts to ride out transient Redis restarts / DNS / iptables races on
// Pod startup.
const (
	redisConnectMaxAttempts = 3
	redisConnectBackoff     = 2 * time.Second
)

// Config holds Redis connection settings.
type Config struct {
	Addr     string
	Password string
	DB       int
}

// ConfigFromEnv reads store config from environment variables.
//
// Supported env vars:
//
//	REDIS_URL      redis://[:<password>@]<host>:<port>[/<db>]
//	REDIS_ADDR     <host>:<port>
//	REDIS_PASSWORD <password>
//	REDIS_DB       database index (default 1, to isolate from other projects on DB 0)
func ConfigFromEnv() Config {
	cfg := Config{DB: 1} // default DB 1

	if url := os.Getenv("REDIS_URL"); url != "" {
		cfg = parseRedisURL(url)
		if dbStr := os.Getenv("REDIS_DB"); dbStr != "" {
			if db, err := strconv.Atoi(dbStr); err == nil {
				cfg.DB = db
			}
		}
		return cfg
	}

	cfg.Addr = os.Getenv("REDIS_ADDR")
	cfg.Password = os.Getenv("REDIS_PASSWORD")
	if dbStr := os.Getenv("REDIS_DB"); dbStr != "" {
		if db, err := strconv.Atoi(dbStr); err == nil {
			cfg.DB = db
		}
	}
	return cfg
}

// parseRedisURL parses redis://[:<password>@]<host>:<port>[/<db>]
func parseRedisURL(url string) Config {
	cfg := Config{}
	s := strings.TrimPrefix(url, "redis://")

	if idx := strings.LastIndex(s, "@"); idx >= 0 {
		auth := s[:idx]
		s = s[idx+1:]
		if strings.HasPrefix(auth, ":") {
			cfg.Password = auth[1:]
		} else {
			cfg.Password = auth
		}
	}

	if idx := strings.Index(s, "/"); idx >= 0 {
		dbStr := s[idx+1:]
		s = s[:idx]
		if db, err := strconv.Atoi(dbStr); err == nil {
			cfg.DB = db
		}
	}
	cfg.Addr = s
	return cfg
}

// NewFromEnv creates a Store from environment variables.
//
// STORE_TYPE=redis (default) → RedisStore
// STORE_TYPE=memory          → MemoryStore (dev/test, data lost on restart)
//
// Falls back to MemoryStore if Redis is unreachable (logs a warning).
func NewFromEnv() (Store, error) {
	storeType := strings.ToLower(os.Getenv("STORE_TYPE"))
	if storeType == "" {
		storeType = "redis"
	}

	switch storeType {
	case "memory":
		fmt.Println("[store] Using in-memory store (data lost on restart)")
		return NewMemoryStore(), nil

	case "redis":
		cfg := ConfigFromEnv()
		if cfg.Addr == "" {
			fmt.Println("[store] REDIS_ADDR not set, falling back to in-memory store")
			return NewMemoryStore(), nil
		}
		// Retry Redis connection a few times before falling back to memory.
		// Avoids silent memory degradation when the Redis Pod is briefly
		// unreachable at controlplane startup (e.g. during a rolling upgrade
		// or right after a StorageClass change).
		var (
			rs      *RedisStore
			lastErr error
		)
		for attempt := 1; attempt <= redisConnectMaxAttempts; attempt++ {
			rs, lastErr = NewRedisStore(cfg)
			if lastErr == nil {
				fmt.Printf("[store] Redis connected: addr=%s db=%d (attempt %d/%d)\n",
					cfg.Addr, cfg.DB, attempt, redisConnectMaxAttempts)
				return rs, nil
			}
			fmt.Printf("[store] Redis connect attempt %d/%d failed (addr=%s db=%d): %v\n",
				attempt, redisConnectMaxAttempts, cfg.Addr, cfg.DB, lastErr)
			if attempt < redisConnectMaxAttempts {
				time.Sleep(redisConnectBackoff)
			}
		}
		fmt.Printf("[store] Redis unreachable after %d attempts (addr=%s db=%d): %v — falling back to memory\n",
			redisConnectMaxAttempts, cfg.Addr, cfg.DB, lastErr)
		return NewMemoryStore(), nil

	default:
		return nil, fmt.Errorf("unsupported STORE_TYPE %q, use redis or memory", storeType)
	}
}
