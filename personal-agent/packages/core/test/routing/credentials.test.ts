// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_NOTICE, type KeyOwner, type Logger, type OutMessage } from "@primusclaw/personal-agent";

import { FakeSurface } from "../../../../test-support/surface.js";
import { advanceSeconds, openTestStore } from "../../../../test-support/store.js";
import { Chat } from "../../src/routing/chat.js";
import { CredentialUnavailable, Credentials } from "../../src/routing/credentials.js";
import type { RouterConfig } from "../../src/routing/deps.js";
import { KeyOwners } from "../../src/routing/identity.js";
import { CommandViews } from "../../src/routing/views.js";
import { ALICE, BOB, FakeExchange, note, personal } from "./fixtures.js";
import { link as linkIn, message, said as saidIn, world as routerWorld } from "./world.js";

const PUBLIC = "https://claw.example.com";
const warnings: string[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => {
    warnings.push(message);
  },
  error: () => undefined,
  child: () => logger,
};

function config(exchangeForChat: boolean): RouterConfig {
  return {
    publicBaseUrl: PUBLIC,
    botName: "Clawy",
    pluginId: "",
    model: "",
    reviewModel: "",
    fallbackModel: "",
    exchangeForChat,
    briefEnabled: false,
    schedulesEnabled: false,
    jobWatchEnabled: false,
    ownThumbsMobile: true,
  };
}

function world(exchangeForChat: boolean, locale = "") {
  const { store, clock } = openTestStore();
  const exchange = new FakeExchange();
  const surface = new FakeSurface();
  const views = new CommandViews("Clawy", PUBLIC, note);
  const credentials = new Credentials({ store, exchange, config: config(exchangeForChat), logger }, views);
  const chat = (who = ALICE) => new Chat(store, who, surface.conversation(personal()), "", locale);
  return { store, clock, exchange, surface, credentials, chat };
}

function cards(surface: FakeSurface): { name: string; lead: string; confirmUrl: string }[] {
  return surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "view"
      ? [
          {
            name: r.message.body.view.name,
            lead: (r.message.body.view.model as { lead?: string }).lead ?? "",
            confirmUrl: (r.message.body.view.model as { confirmUrl?: string }).confirmUrl ?? "",
          },
        ]
      : [],
  );
}

function said(surface: FakeSurface): string[] {
  return surface.outbox.flatMap((r) => (r.op === "send" ? [describe(r.message)] : []));
}

function describe(message: OutMessage): string {
  if (message.body.type === "view") return `view:${message.body.view.name}`;
  return message.body.type === "text" ? message.body.text : message.body.markdown;
}

function link(store: ReturnType<typeof openTestStore>["store"], userId: string, key: string): void {
  assert.equal(store.links.redeemPending(userId, "Alice", store.links.stashPending(key)), "ok");
}

test("with chats on the linked key: the key, else the /link steps in the person's language", async () => {
  const w = world(false);
  assert.equal(w.credentials.onExchange, false);
  assert.equal(await w.credentials.credential(w.chat()), undefined);
  const [steps] = said(w.surface);
  assert.ok(steps?.includes(`${PUBLIC}/primus-claw/teams-link`) && steps.trimEnd().endsWith(AI_NOTICE.en));
  assert.equal(await w.credentials.credential(w.chat(), false), undefined);
  assert.equal(said(w.surface).length, 1); // (not asked: nothing said)
  link(w.store, ALICE.id, "ak-alice");
  assert.equal(await w.credentials.credential(w.chat()), "ak-alice");
  assert.equal(w.credentials.provider(ALICE.id, "ak-alice"), undefined);
  const zh = world(false, "zh-CN");
  await zh.credentials.askToLink(zh.chat(), "You mentioned me in a group chat. ");
  await zh.credentials.askToLink(zh.chat(), "Another service. ");
  const [dm, other] = said(zh.surface);
  assert.ok(dm?.startsWith("你在群聊里 @ 了我。要使用 Clawy") && !dm.includes(AI_NOTICE.en));
  assert.ok(other?.startsWith("Another service. To use Clawy")); // (a lead of another service's: all English)
});

test("with chats on the exchange: the token, else the key, else the binding card; a down service is said", async () => {
  const w = world(true);
  assert.equal(w.credentials.onExchange, true);
  assert.equal(await w.credentials.credential(w.chat()), undefined);
  assert.deepEqual(said(w.surface), ["view:binding"]);
  w.exchange.tokens.set(ALICE.id, "tok-a");
  assert.equal(await w.credentials.credential(w.chat()), "tok-a");
  const provider = w.credentials.provider(ALICE.id, "ak");
  assert.equal(await provider?.(), "tok-a");
  w.exchange.down = true;
  assert.equal(await w.credentials.credential(w.chat(), false), undefined);
  assert.equal(await w.credentials.credential(w.chat()), undefined);
  assert.equal(
    said(w.surface).at(-1),
    "I could not reach the Primus platform to check your connection. Please try again in a minute.",
  );
  link(w.store, ALICE.id, "ak-alice");
  assert.equal(await w.credentials.credential(w.chat()), "ak-alice"); // (down, but there is a key)
  assert.equal(await w.credentials.fresh(ALICE.id, "ak-alice"), "ak-alice");
  w.exchange.down = false;
  w.exchange.tokens.delete(ALICE.id);
  assert.equal(await w.credentials.credential(w.chat()), "ak-alice"); // (not bound: the key)
  w.exchange.bindingDown = true;
  const card = await w.credentials.bindingCard(w.chat(BOB));
  assert.ok(card.body.type === "view" && card.body.view.name === "link");
  assert.equal(card.body.view.model.who, "bob@example.com");
  const unnamed = await w.credentials.bindingCard(w.chat({ ...ALICE, name: "" }));
  assert.ok(unnamed.body.type === "view" && unnamed.body.view.name === "link");
  assert.equal(unnamed.body.view.model.who, "your Teams account (this chat)");
});

test("a reader with nobody writing: the token, else the key; a down service is not 'no credential'", async () => {
  const w = world(false);
  assert.equal(await w.credentials.background(ALICE.id), undefined);
  w.exchange.enabled = false;
  link(w.store, ALICE.id, "ak-alice");
  assert.equal(await w.credentials.background(ALICE.id), "ak-alice");
  w.exchange.enabled = true;
  w.exchange.tokens.set(ALICE.id, "tok-a");
  assert.equal(await w.credentials.background(ALICE.id), "tok-a");
  w.exchange.down = true;
  assert.equal(await w.credentials.background(ALICE.id), "ak-alice");
  await assert.rejects(w.credentials.background(BOB.id), CredentialUnavailable);
});

test("the key's owner is read three ways, and nothing when the platform cannot say", async () => {
  const owners = new Map<string, KeyOwner>([
    ["k1", { id: " u1 ", name: " Alice ", email: " a@example.com ", accountType: "sso" }],
    ["k2", { id: "", name: "", email: "", accountType: "" }],
  ]);
  const ask = new KeyOwners({ ownerOfKey: (key) => Promise.resolve(owners.get(key)) });
  assert.deepEqual(await ask.whoami("k1"), ["Alice", "a@example.com"]);
  assert.equal(await ask.whoami("k2"), undefined);
  assert.equal(await ask.userIdOf("k1"), "u1");
  assert.equal(await ask.userIdOf("k2"), undefined);
  assert.equal(await ask.userIdOf("k3"), undefined);
  assert.equal(await ask.whoLine("k1"), " to SaFE user Alice (a@example.com)");
  assert.equal(await ask.whoLine("k1", false), " to SaFE user Alice");
  assert.equal(await ask.whoLine(undefined), undefined);
});

test("the owner's name, email and id are stripped as Python strips them: a byte-order mark stays", async () => {
  // (JavaScript's trim() takes U+FEFF as whitespace; Python's str.strip() does not)
  const owners = new Map<string, KeyOwner>([
    ["bom", { id: "\uFEFF", name: "\uFEFF", email: "", accountType: "sso" }],
    ["vi", { id: " u-vi ", name: "\uFEFFVi ", email: " \uFEFFvi@example.com", accountType: "sso" }],
  ]);
  const ask = new KeyOwners({ ownerOfKey: (key) => Promise.resolve(owners.get(key)) });
  assert.notEqual(await ask.owner("bom"), undefined); // (Python: "\uFEFF".strip() is not empty: someone is named)
  assert.deepEqual(await ask.whoami("bom"), ["\uFEFF", ""]);
  assert.equal(await ask.userIdOf("bom"), "\uFEFF");
  assert.deepEqual(await ask.whoami("vi"), ["\uFEFFVi", "\uFEFFvi@example.com"]);
});

test("the Python worker's answers for /users/self with byte-order marks (generated by running safe.py)", async () => {
  const owners = new Map<string, KeyOwner>([
    ["k1", { id: "u-1021", name: "\uFEFF", email: "", accountType: "" }],
    ["k2", { id: "\uFEFFu-1022", name: "\uFEFFVi", email: "v@example.com\uFEFF", accountType: "" }],
  ]);
  const ask = new KeyOwners({ ownerOfKey: (key) => Promise.resolve(owners.get(key)) });
  assert.deepEqual(await ask.whoami("k1"), ["\uFEFF", ""]);
  assert.equal(await ask.userIdOf("k1"), "u-1021");
  assert.deepEqual(await ask.whoami("k2"), ["\uFEFFVi", "v@example.com\uFEFF"]);
  assert.equal(await ask.userIdOf("k2"), "\uFEFFu-1022");
});

test("/whoami says the owner's name as Python strips it: a byte-order mark stays", async () => {
  const w = routerWorld();
  linkIn(w, ALICE.id, "ak-alice");
  w.owners.set("ak-alice", { id: "u-a", name: "\uFEFFVi ", email: "", accountType: "sso" });
  await w.router.handle(message("/whoami"));
  assert.ok(
    saidIn(w).some((t) => t.includes("connected to SaFE user \uFEFFVi")),
    saidIn(w).join(" | "),
  );
});

test("a key's owner who never confirmed their identity is answered on the key, with no card before it", async () => {
  // (connecting a machine and the rest of what a key may do are not held behind the identity: the card comes only after an
  // answer that was refused for want of it, `identityAfterRefusal`)
  const w = world(true, "zh-CN");
  link(w.store, ALICE.id, "ak-alice");
  assert.equal(await w.credentials.credential(w.chat()), "ak-alice");
  advanceSeconds(w.clock, 86_400);
  assert.equal(await w.credentials.credential(w.chat()), "ak-alice");
  assert.deepEqual(said(w.surface), []);
});

test("after an answer refused for want of a confirmed identity: the card, unless confirmed by now", async () => {
  const w = world(true, "zh-CN");
  assert.equal(await w.credentials.identityAfterRefusal(w.chat()), true);
  assert.deepEqual(
    cards(w.surface).map((c) => [c.name, c.lead]),
    [["binding", "这一步需要你本人：在这张卡片上确认一次身份，然后再说一遍就行。"]],
  );
  w.exchange.tokens.set(ALICE.id, "tok-a");
  assert.equal(await w.credentials.identityAfterRefusal(w.chat()), false);
  w.exchange.tokens.delete(ALICE.id);
  w.exchange.down = true;
  assert.equal(await w.credentials.identityAfterRefusal(w.chat()), false, "the service down: not 'not bound'");
  w.exchange.down = false;
  w.exchange.bindingDown = true;
  assert.equal(await w.credentials.identityAfterRefusal(w.chat()), false);
  assert.equal(cards(w.surface).length, 1);
  const keyOnly = world(false);
  assert.equal(await keyOnly.credentials.identityAfterRefusal(keyOnly.chat()), false);
  assert.deepEqual(said(keyOnly.surface), []);
});
