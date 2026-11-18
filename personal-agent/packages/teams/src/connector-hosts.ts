// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-teams/connector-hosts: the Bot Connector host rule alone (where the bot's token may be
 * sent), for the Teams ingress (@primusclaw/personal-agent-teams-ingress), which applies the worker's rule to the
 * serviceUrl of every activity it accepts. An entry of its own so that the ingress loads this module and core, not the
 * worker.
 */
export { ConnectorHosts, DEFAULT_CONNECTOR_HOSTS, DEFAULT_HOSTS, DEFAULT_SUFFIXES } from "./connector/hosts.js";
export type { ServiceUrlPolicy } from "./connector/hosts.js";
export { UnaddressableError } from "./connector/errors.js";
