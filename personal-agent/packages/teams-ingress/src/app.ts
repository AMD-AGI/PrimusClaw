// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The ingress as a Function app runs it: built from the app settings, registered with the Functions host. */
import { app } from "@azure/functions";

import { type Env } from "./env.js";
import { consoleSink, type Registrar, register } from "./functions.js";
import { createIngress, type Ingress } from "./ingress.js";
import { SERVICE_BUS } from "./servicebus.js";

/** The Ingress a Function app runs: real HTTP and Service Bus, records outside an invocation on the console. */
export function hostedIngress(env: Env): Ingress {
  return createIngress({ env, fetch: globalThis.fetch, log: consoleSink, serviceBus: SERVICE_BUS });
}

/** Register the ingress, built from `env`, on `registrar` (the Functions host's `app`). */
export function start(registrar: Registrar = app, env: Env = process.env): Ingress {
  const ingress = hostedIngress(env);
  register(registrar, ingress);
  return ingress;
}
