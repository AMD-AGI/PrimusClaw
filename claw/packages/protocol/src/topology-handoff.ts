// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * TopologyHandoff v1: what Claw tells a sandbox about the multi-node cluster it
 * already provisioned for the run.
 *
 * It is delivered as a JSON file, and the file's path is the value of
 * `TOPOLOGY_HANDOFF_FILE` in the sandbox env. Claw owns this contract; a reader
 * needs nothing but this shape.
 *
 * Credentials are never carried inline. A private key is its own file and the
 * document holds only the path to it, so the document can be read, logged or
 * attached to a report without exposing a secret. The files live in a
 * sandbox-local directory outside the synced workspace, so a workspace snapshot
 * never carries them and a restore never overwrites them.
 *
 * Only the block of the active backend is present: `ray` for `rayjob`, `infera`
 * for `infera`. Optional fields are omitted when Claw has no value for them
 * rather than written as empty strings.
 */

export const TOPOLOGY_HANDOFF_SCHEMA = "topology-handoff/v1" as const;

export type TopologyHandoffBackend = "rayjob" | "infera";

export interface TopologyHandoffRay {
  head_ip?: string;
}

export interface TopologyHandoffInfera {
  /** File holding the SSH private key (mode 0600). Never the key itself. */
  ssh_key_file?: string;
  ssh_port_base?: number;
  /** File ssh may record and read host keys in. */
  known_hosts_file?: string;
  prefill_ips: string[];
  decode_ips: string[];
  worker_ips: string[];
}

export interface TopologyHandoffV1 {
  schema: typeof TOPOLOGY_HANDOFF_SCHEMA;
  backend: TopologyHandoffBackend;
  nodes: number;
  gpus_per_node: number;
  service_url: string;
  ray?: TopologyHandoffRay;
  infera?: TopologyHandoffInfera;
}

const IP_LIST = { type: "array", items: { type: "string", minLength: 1 } } as const;

/** JSON Schema (draft 2020-12) for {@link TopologyHandoffV1}. */
export const TOPOLOGY_HANDOFF_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TOPOLOGY_HANDOFF_SCHEMA,
  type: "object",
  additionalProperties: false,
  required: ["schema", "backend", "nodes", "gpus_per_node", "service_url"],
  // The block of the active backend, and only that block.
  allOf: [
    {
      if: { properties: { backend: { const: "rayjob" } } },
      then: { required: ["ray"], not: { required: ["infera"] } },
    },
    {
      if: { properties: { backend: { const: "infera" } } },
      then: { required: ["infera"], not: { required: ["ray"] } },
    },
  ],
  properties: {
    schema: { const: TOPOLOGY_HANDOFF_SCHEMA },
    backend: { enum: ["rayjob", "infera"] },
    nodes: { type: "integer", minimum: 1 },
    gpus_per_node: { type: "integer", minimum: 1 },
    service_url: { type: "string", minLength: 1 },
    ray: {
      type: "object",
      additionalProperties: false,
      properties: {
        head_ip: { type: "string", minLength: 1 },
      },
    },
    infera: {
      type: "object",
      additionalProperties: false,
      required: ["prefill_ips", "decode_ips", "worker_ips"],
      properties: {
        ssh_key_file: { type: "string", minLength: 1 },
        ssh_port_base: { type: "integer", minimum: 1, maximum: 65535 },
        known_hosts_file: { type: "string", minLength: 1 },
        prefill_ips: IP_LIST,
        decode_ips: IP_LIST,
        worker_ips: IP_LIST,
      },
    },
  },
} as const;

/**
 * Structural check against {@link TOPOLOGY_HANDOFF_JSON_SCHEMA}. Returns the
 * problems found; an empty list means valid. Hand-written because this package
 * carries no schema validator, and kept to the keywords the schema uses.
 */
export function validateTopologyHandoff(value: unknown): string[] {
  const problems: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const checkObject = (
    path: string,
    v: unknown,
    schema: { required?: readonly string[]; properties: Record<string, unknown> },
    check: (key: string, val: unknown) => void,
  ): void => {
    if (!isObj(v)) {
      problems.push(`${path || "(root)"}: must be an object`);
      return;
    }
    for (const k of schema.required ?? []) if (!(k in v)) problems.push(`${path}${k}: required`);
    for (const [k, val] of Object.entries(v)) {
      if (!(k in schema.properties)) problems.push(`${path}${k}: unknown field`);
      else check(k, val);
    }
  };
  const str = (p: string, v: unknown): void => {
    if (typeof v !== "string" || v.length === 0) problems.push(`${p}: must be a non-empty string`);
  };
  const int = (p: string, v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
      problems.push(`${p}: must be an integer in [${min}, ${max}]`);
    }
  };
  const list = (p: string, v: unknown): void => {
    if (!Array.isArray(v)) problems.push(`${p}: must be an array`);
    else v.forEach((x, i) => str(`${p}[${i}]`, x));
  };
  const S = TOPOLOGY_HANDOFF_JSON_SCHEMA;
  checkObject("", value, S, (k, v) => {
    switch (k) {
      case "schema":
        if (v !== TOPOLOGY_HANDOFF_SCHEMA) problems.push(`schema: must be ${TOPOLOGY_HANDOFF_SCHEMA}`);
        break;
      case "backend":
        if (!S.properties.backend.enum.includes(v as never)) problems.push("backend: must be rayjob or infera");
        break;
      case "nodes":
        int("nodes", v, 1);
        break;
      case "gpus_per_node":
        int("gpus_per_node", v, 1);
        break;
      case "service_url":
        str("service_url", v);
        break;
      case "ray":
        checkObject("ray.", v, S.properties.ray, (rk, rv) => str(`ray.${rk}`, rv));
        break;
      case "infera":
        checkObject("infera.", v, S.properties.infera, (ik, iv) => {
          if (ik === "ssh_port_base") int("infera.ssh_port_base", iv, 1, 65535);
          else if (ik.endsWith("_ips")) list(`infera.${ik}`, iv);
          else str(`infera.${ik}`, iv);
        });
        break;
    }
  });
  // Backend/block consistency (the schema's allOf). Only checked once the
  // backend itself is valid, so one mistake is not reported twice.
  if (isObj(value) && (value.backend === "rayjob" || value.backend === "infera")) {
    const [want, other] = value.backend === "rayjob" ? (["ray", "infera"] as const) : (["infera", "ray"] as const);
    if (!(want in value)) problems.push(`${want}: required when backend is ${value.backend}`);
    if (other in value) problems.push(`${other}: not allowed when backend is ${value.backend}`);
  }
  return problems;
}
