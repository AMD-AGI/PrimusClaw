// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Conversation references, preferences, held notices, the member directory and notification subscriptions.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TIMEZONE, HELD_TTL_SECONDS, MAX_HELD_PER_USER, PAUSE_FOREVER } from "@primusclaw/personal-agent";

import { advanceSeconds, openFileTestStore, openTestStore } from "../../../../test-support/index.js";

test("a reference is kept without its activity id, with when the person last wrote", () => {
  const { store } = openTestStore();
  assert.equal(store.references.getReference("aad-a"), null);
  assert.equal(store.references.lastInboundAt("aad-a"), null);
  store.references.saveReference("aad-a", { activityId: "x", serviceUrl: "https://s", conversation: { id: "c" } });
  assert.deepEqual(store.references.getReference("aad-a"), { serviceUrl: "https://s", conversation: { id: "c" } });
  assert.equal(store.references.lastInboundAt("aad-a"), store.now());
});

test("preferences default, and each setting changes only itself", () => {
  const { store } = openTestStore();
  const prefs = store.prefs;
  assert.deepEqual(prefs.getPrefs("aad-a"), {
    timezone: DEFAULT_TIMEZONE,
    quietEnabled: true,
    quietStart: "22:00",
    quietEnd: "08:00",
    pausedUntil: null,
    briefTriggerId: null,
    lang: "",
    langSet: false,
    remoteWindow: "",
  });
  prefs.setQuiet("aad-a", ["23:00", "07:30"]);
  prefs.setTimezone("aad-a", "Europe/Berlin");
  prefs.setPausedUntil("aad-a", PAUSE_FOREVER);
  prefs.setBriefTrigger("aad-a", "t-1");
  prefs.setRemoteWindowPref("aad-a", "card");
  prefs.setRemoteWindowPref("aad-a", "nonsense");
  assert.deepEqual(prefs.getPrefs("aad-a"), {
    timezone: "Europe/Berlin",
    quietEnabled: true,
    quietStart: "23:00",
    quietEnd: "07:30",
    pausedUntil: PAUSE_FOREVER,
    briefTriggerId: "t-1",
    lang: "",
    langSet: false,
    remoteWindow: "card",
  });
  prefs.setQuiet("aad-a", null);
  prefs.setPausedUntil("aad-a", null);
  assert.equal(prefs.getPrefs("aad-a").quietEnabled, false);
  assert.equal(prefs.getPrefs("aad-a").pausedUntil, null);
  assert.equal(prefs.getTimezone("aad-a"), "Europe/Berlin");
  prefs.setLang("aad-b", "zh");
  assert.equal(prefs.getTimezone("aad-b"), DEFAULT_TIMEZONE);
});

test("the language is learnt from what is written until the person says which", () => {
  const { store } = openTestStore();
  const prefs = store.prefs;
  prefs.learnLang("aad-a", "zh");
  assert.deepEqual([prefs.getPrefs("aad-a").lang, prefs.getPrefs("aad-a").langSet], ["zh", false]);
  prefs.setLang("aad-a", "en");
  prefs.learnLang("aad-a", "zh");
  assert.deepEqual([prefs.getPrefs("aad-a").lang, prefs.getPrefs("aad-a").langSet], ["en", true]);
  prefs.setLang("aad-a", "en", false);
  prefs.learnLang("aad-a", "zh");
  assert.equal(prefs.getPrefs("aad-a").lang, "zh");
});

test("unlink clears the person's brief trigger but keeps their other preferences", () => {
  const { store } = openTestStore();
  store.prefs.setBriefTrigger("aad-a", "t-1");
  store.prefs.setTimezone("aad-a", "UTC");
  store.links.unlink("aad-a");
  assert.equal(store.prefs.getPrefs("aad-a").briefTriggerId, null);
  assert.equal(store.prefs.getTimezone("aad-a"), "UTC");
});

test("held events: one per id, oldest first, the newest 100 per person, a week at most, taken once", () => {
  const { store, clock } = openTestStore();
  const held = store.held;
  held.holdEvent("aad-a", { event_id: "e1", n: 1 });
  advanceSeconds(clock, 1);
  held.holdEvent("aad-a", { event_id: "e1", n: 99 });
  held.holdEvent("aad-a", { event_id: 2, n: 2 });
  held.holdEvent("aad-b", { event_id: "b1" });
  assert.deepEqual(new Set(held.usersWithHeld()), new Set(["aad-a", "aad-b"]));
  assert.deepEqual(held.takeHeld("aad-a"), [
    { event_id: "e1", n: 1 },
    { event_id: 2, n: 2 },
  ]);
  assert.deepEqual(held.takeHeld("aad-a"), []);
  for (let i = 0; i < MAX_HELD_PER_USER + 5; i++) held.holdEvent("aad-c", { event_id: `c${String(i)}` });
  const kept = held.takeHeld("aad-c");
  assert.equal(kept.length, MAX_HELD_PER_USER);
  assert.deepEqual(kept[0], { event_id: "c5" });
  advanceSeconds(clock, HELD_TTL_SECONDS + 1);
  held.holdEvent("aad-d", { event_id: "d1" });
  assert.deepEqual(held.usersWithHeld(), ["aad-d"]);
  assert.throws(() => {
    held.holdEvent("aad-d", { other: 1 });
  }, RangeError);
  held.holdEvent("aad-e", { event_id: null });
  held.holdEvent("aad-e", { event_id: true });
  assert.equal(held.takeHeld("aad-e").length, 2);
});

test("the member directory knows people by their channel id and keeps a known address", () => {
  const { store, clock } = openTestStore();
  const members = store.members;
  members.rememberMember("29:a", "aad-a", "Alice", "alice@example.com");
  advanceSeconds(clock, 1);
  members.rememberMember("29:a", "aad-a", "Alice A.");
  advanceSeconds(clock, 1);
  members.rememberMember("29:b", "aad-b", "");
  members.rememberMemberEmails([
    { id: "29:b", userPrincipalName: " bob@example.com " },
    { id: "29:x", email: "x@example.com" },
    { id: "29:a", email: "not-an-address" },
    { id: 7, email: "seven@example.com" },
    {},
  ]);
  assert.deepEqual(members.knownMembers(), [
    { id: "29:b", objectId: "aad-b", name: "", email: "bob@example.com" },
    { id: "29:a", objectId: "aad-a", name: "Alice A.", email: "alice@example.com" },
  ]);
  assert.equal(members.knownMembers(1).length, 1);
  assert.equal(members.userForChannelId("29:a"), "aad-a");
  assert.equal(members.userForChannelId("29:z"), null);
  assert.equal(members.channelIdOf("aad-b"), "29:b");
  assert.equal(members.channelIdOf("aad-z"), null);
  assert.equal(members.memberName("aad-a"), "Alice A.");
  assert.equal(members.memberName("aad-b"), null);
  assert.equal(members.clickedPersonally("aad-a"), false);
  members.notePersonalClick("aad-a");
  assert.equal(members.clickedPersonally("aad-a"), true);
});

test("a notification subscription is found by its route, its secret encrypted, its attempts rationed", () => {
  const f = openFileTestStore();
  try {
    const subs = f.store.notifySubs;
    assert.equal(subs.getNotifySub("aad-a"), null);
    assert.equal(subs.notifyTypesVersion("aad-a"), null);
    subs.saveNotifySub("aad-a", { route: "r-a", subscriptionId: "sub-a", secret: "whsec-a" });
    assert.deepEqual(subs.getNotifySub("aad-a"), { route: "r-a", subscriptionId: "sub-a" });
    assert.deepEqual(subs.notifySubByRoute("r-a"), { userId: "aad-a", secret: "whsec-a" });
    assert.equal(subs.notifySubByRoute("r-none"), null);
    const raw = f.raw.prepare("SELECT secret_enc FROM notify_subs").get()?.["secret_enc"];
    assert.ok(raw instanceof Uint8Array && !Buffer.from(raw).includes("whsec-a"));
    assert.equal(subs.notifyTypesVersion("aad-a"), 0);
    subs.setNotifyTypesVersion("aad-a", 2);
    assert.equal(subs.notifyTypesVersion("aad-a"), 2);
    assert.equal(subs.claimNotifyAttempt("aad-a", 60), true);
    assert.equal(subs.claimNotifyAttempt("aad-a", 60), false);
    advanceSeconds(f.clock, 60);
    assert.equal(subs.claimNotifyAttempt("aad-a", 60), true);
    f.raw.prepare("UPDATE notify_subs SET secret_enc = x'00'").run();
    assert.equal(subs.notifySubByRoute("r-a"), null);
    subs.forgetNotifySub("aad-a");
    assert.equal(subs.getNotifySub("aad-a"), null);
    assert.equal(subs.claimNotifyAttempt("aad-a", 60), true);
  } finally {
    f.close();
  }
});
