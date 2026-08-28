// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// memory/storage-client.ts
import pino from "pino";
import * as prom from "prom-client";

const logger = pino({ name: "storage-memory-client" });

const requestsTotal = new prom.Counter({
  name: "storage_client_requests_total",
  help: "Total HTTP requests from storage memory client",
  labelNames: ["operation", "status"],
});

const requestDuration = new prom.Histogram({
  name: "storage_client_request_duration_seconds",
  help: "Duration of HTTP requests from storage memory client",
  labelNames: ["operation"],
});

const errorsTotal = new prom.Counter({
  name: "storage_client_errors_total",
  help: "Total errors from storage memory client",
  labelNames: ["operation", "error_kind"],
});

export class StorageMemoryError extends Error {
  constructor(public status: number, public body: any) {
    super(`Memory Storage error ${status}: ${JSON.stringify(body)}`);
  }
}

export class StorageMemoryClient {
  private baseUrl = process.env.MEMORY_SERVICE_URL || "http://127.0.0.1:8765";

  private async request(operation: string, path: string, options: RequestInit) {
    const endTimer = requestDuration.labels(operation).startTimer();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
      });
      
      requestsTotal.labels(operation, response.status.toString()).inc();
      
      if (!response.ok) {
        errorsTotal.labels(operation, `http_${response.status}`).inc();
        const body = await response.text().catch(() => "");
        let parsed = body;
        try { parsed = JSON.parse(body); } catch {}
        throw new StorageMemoryError(response.status, parsed);
      }
      
      if (response.status === 204) {
        endTimer();
        return null;
      }
      
      const text = await response.text();
      if (!text) {
        endTimer();
        return null;
      }
      
      endTimer();
      return JSON.parse(text);
    } catch (err) {
      if (!(err instanceof StorageMemoryError)) {
        errorsTotal.labels(operation, "network").inc();
      }
      logger.error({ err, operation }, "Memory Storage request failed");
      throw err;
    }
  }

  async list(userId: string, limit: number) {
    return this.request("list", "/api/memories/list", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, limit }),
    });
  }

  async insert(userId: string, entry: any) {
    return this.request("insert", "/api/memories/insert", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, entry }),
    });
  }

  async delete(userId: string, entryId: string) {
    return this.request("delete", `/api/memories/${entryId}?user_id=${userId}`, {
      method: "DELETE",
    });
  }

  async update(userId: string, entryId: string, updates: { content?: string; category?: string; importance?: number }) {
    return this.request("update", `/api/memories/${entryId}`, {
      method: "PUT",
      body: JSON.stringify({ user_id: userId, ...updates }),
    });
  }

  async deleteAll(userId: string) {
    return this.request("delete_all", "/api/memories", {
      method: "DELETE",
      body: JSON.stringify({ user_id: userId }),
    });
  }

  async getProfile(userId: string) {
    return this.request("get_profile", `/api/memories/profile/${userId}`, {
      method: "GET",
    });
  }

  async upsertProfile(userId: string, content: string) {
    return this.request("upsert_profile", "/api/memories/profile", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, content }),
    });
  }
}
