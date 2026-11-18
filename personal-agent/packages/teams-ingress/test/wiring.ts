// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The ingress wired for the ported test_ingress.py tests: Service Bus, token endpoint, validation and Connector faked. */
import { AuthError } from "../src/auth.js";
import { register, type Registrar } from "../src/functions.js";
import { type Ingress } from "../src/ingress.js";
import { FULL_ENV, type Loaded, load as loadWith } from "./helpers.js";

export interface Wired extends Loaded {
  validated: { app_id: string; service_url?: unknown }[];
}

/** function_app with Service Bus, token endpoint, validation and Connector faked. */
export function wired(env: Record<string, string> = FULL_ENV): Wired {
  const loaded = loadWith(env);
  const validated: Wired["validated"] = [];
  loaded.ingress.validate = (_header, kw) => {
    validated.push({ app_id: kw.appId, service_url: kw.serviceUrl });
    return Promise.resolve({});
  };
  loaded.ingress.validateToken = (_header, kw) => {
    validated.push({ app_id: kw.appId });
    return Promise.resolve({});
  };
  return { ...loaded, validated };
}

export function refuseTokens(ingress: Ingress): void {
  const refuse = (): Promise<never> => Promise.reject(new AuthError("bad"));
  ingress.validate = refuse;
  ingress.validateToken = refuse;
}

export function brokenEnqueue(ingress: Ingress): void {
  ingress.enqueue = () => Promise.reject(new Error("bus down"));
}

export interface Registration {
  trigger: "httpTrigger" | "serviceBusTrigger";
  options: Readonly<Record<string, unknown>>;
}

/** The registrations the Function makes, by name, with their options. */
export function functions(ingress: Ingress): Map<string, Registration> {
  const registered = new Map<string, Registration>();
  const recorder: Registrar = {
    http: (name, options) => {
      registered.set(name, { trigger: "httpTrigger", options });
    },
    serviceBusQueue: (name, options) => {
      registered.set(name, { trigger: "serviceBusTrigger", options });
    },
  };
  register(recorder, ingress);
  return registered;
}

export const runOutbound = (ingress: Ingress, envelope: unknown) =>
  ingress.outbound(Buffer.from(JSON.stringify(envelope)));
