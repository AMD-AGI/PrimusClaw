// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Function app's entry point (the deployable package's `main`): one Ingress per worker process, from the app
 * settings, registered with the Functions host. Importing this module registers the functions.
 */
import { start } from "./app.js";

start();
