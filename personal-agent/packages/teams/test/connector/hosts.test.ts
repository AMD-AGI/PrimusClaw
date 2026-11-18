// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Bot Connector host rule, and the release gate's one-origin rule, as injected policies. */
import assert from "node:assert/strict";
import test from "node:test";
import { UnaddressableError } from "../../src/connector/errors.js";
import {
  ConnectorHosts,
  DEFAULT_CONNECTOR_HOSTS as DEFAULT,
  DEFAULT_HOSTS,
  DEFAULT_SUFFIXES,
  onlyConnector,
  type ServiceUrlPolicy,
} from "../../src/connector/hosts.js";
import { buildCreateConversation, buildListMembers, buildRequest } from "../../src/connector/request.js";
import { envelope, RecordingLogger, reference } from "./fakes.js";

test("the worker uses the shared rule", () => {
  const seen: unknown[] = [];
  const spy: ServiceUrlPolicy = { check: (url) => void seen.push(url) };
  buildRequest(envelope("hi", { ref: reference("19:a", "https://anything.example/") }), spy);
  buildCreateConversation("https://anything.example/", "29:u", "t", "28:b", spy);
  buildListMembers("https://anything.example/", "19:a", spy);
  assert.deepEqual(seen, ["https://anything.example/", "https://anything.example/", "https://anything.example/"]);
});

for (const url of [
  "https://smba.trafficmanager.net/teams/",
  "https://SMBA.trafficmanager.net/emea",
  "https://webchat.botframework.com/",
  "https://x.botframework.us/",
  "https://smba.infra.gov.teams.microsoft.us/gcch",
  "https://a.teams.microsoft.com:443/",
]) {
  test(`microsofts hosts pass: ${url}`, () => {
    DEFAULT.check(url);
  });
}

for (const url of [
  "http://smba.trafficmanager.net/teams",
  "https://attacker.trafficmanager.net/",
  "https://evil.example.com",
  "https://smba.trafficmanager.net.evil.com/",
  "https://evilbotframework.com",
  "https://botframework.com/",
  "https://user:pw@smba.trafficmanager.net/",
  "https://smba.trafficmanager.net:8443/",
  "https://smba.trafficmanager.net:x/",
  "",
  null,
  42,
  // what WHATWG parsing would read differently from Python's urlsplit
  "https://smba.trafficmanager.net\\@evil.example/",
  "https://smba.traffic\tmanager.net/",
]) {
  test(`anything else is refused: ${JSON.stringify(url)}`, () => {
    assert.throws(() => {
      DEFAULT.check(url);
    }, UnaddressableError);
  });
}

test("host returns the lower cased host", () => {
  assert.equal(DEFAULT.host("https://SMBA.trafficmanager.net/teams"), "smba.trafficmanager.net");
  assert.throws(
    () => DEFAULT.host("https://evil.example/"),
    /the serviceUrl host evil.example is not a Bot Connector host/,
  );
  assert.throws(() => DEFAULT.host("nonsense"), /the serviceUrl host \? is not a Bot Connector host/);
});

test("unset settings keep the defaults", () => {
  const hosts = ConnectorHosts.fromSettings(undefined, undefined);
  assert.deepEqual([hosts.hosts, hosts.suffixes], [DEFAULT.hosts, DEFAULT.suffixes]);
  assert.deepEqual(DEFAULT.hosts, DEFAULT_HOSTS);
  assert.deepEqual(DEFAULT_HOSTS, ["smba.trafficmanager.net"]);
  assert.deepEqual(DEFAULT.suffixes, DEFAULT_SUFFIXES);
});

test("a set setting replaces its default", () => {
  const hosts = ConnectorHosts.fromSettings("bots.contoso.example", "");
  assert.deepEqual([hosts.hosts, hosts.suffixes], [["bots.contoso.example"], []]);
  assert.throws(() => {
    hosts.check("https://smba.trafficmanager.net/teams");
  }, UnaddressableError);
  assert.throws(() => {
    hosts.check("https://webchat.botframework.com/");
  }, UnaddressableError);
  hosts.check("https://bots.contoso.example/");
});

test("entries are normalised and bad ones dropped", () => {
  const logger = new RecordingLogger();
  const hosts = ConnectorHosts.fromSettings(
    " SMBA.trafficmanager.net ; ;https://x.example,net",
    "*.botframework.com, .Teams.Microsoft.com; .net; *; com;*.a..b",
    logger,
  );
  assert.deepEqual(hosts.hosts, ["smba.trafficmanager.net"]);
  assert.deepEqual(hosts.suffixes, [".botframework.com", ".teams.microsoft.com"]);
  const ignored = logger.records.filter((r) => r.level === "error" && r.message.startsWith("ignoring Bot Connector"));
  assert.equal(ignored.length, 6);
});

test("an entry with a letter that is not ASCII is dropped, not folded into a host", () => {
  const logger = new RecordingLogger();
  // U+212A KELVIN SIGN lower-cases to "k" in JS and Python alike; a host name has no such letter
  assert.deepEqual(ConnectorHosts.fromSettings("Key.example", undefined, logger).hosts, []);
  assert.equal(logger.records.length, 1);
});

test("the release gate's rule allows its one origin and nothing else", () => {
  const gate = onlyConnector("http://127.0.0.1:41234/");
  gate.check("http://127.0.0.1:41234/amer/");
  gate.check("http://127.0.0.1:41234");
  for (const url of [
    "https://smba.trafficmanager.net/amer/",
    "http://127.0.0.1:41235/",
    "https://127.0.0.1:41234/",
    "http://user@127.0.0.1:41234/",
    "http://localhost:41234/",
    "not a url",
    42,
  ]) {
    assert.throws(
      () => {
        gate.check(url);
      },
      /not the release gate's recording connector/,
      String(url),
    );
  }
  assert.throws(() => onlyConnector("nonsense"), UnaddressableError);
  // a request built under the gate's rule goes to the recording connector
  const request = buildRequest(envelope("hi", { ref: reference("19:a", "http://127.0.0.1:41234/") }), gate);
  assert.equal(request.url, "http://127.0.0.1:41234/v3/conversations/19:a/activities");
  assert.throws(() => buildRequest(envelope("hi"), gate), UnaddressableError);
});
