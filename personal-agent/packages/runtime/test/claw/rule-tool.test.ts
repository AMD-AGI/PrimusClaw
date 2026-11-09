// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** CLAW_RULE_TOOL_ID: the reply-style rule is a Claw rule tool, and the client attaches it to every message. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANGE_HEADING,
  CHANGE_SUMMARY_RULE,
  ClawAnswerInvalid,
  RULE_HEADING,
  RULE_MAX_BYTES,
  RULE_TTL_MS,
} from "@primusclaw/personal-agent";
import { ruleText } from "../../src/index.js";
import { FakeClock, json, RecordingLogger, Wire, zip, type Sent } from "./wire.js";

const RULE = "Write this reply for a Microsoft Teams chat.\n1. Open with a one-line answer in bold.";
const CHANGE = `${CHANGE_HEADING}\n\n${CHANGE_SUMMARY_RULE}`;
/** Written by Python's `zipfile` (stored), and (deflated, with a directory entry and an upper-case `.MD`). */
const PY_STORED =
  "UEsDBBQAAAAAANRmaV0sQ+EPFQAAABUAAAAHAAAAcnVsZS5tZCAgV3JpdGUgdGhpcyByZXBseS4KClBLAQIUAxQAAAAAANRmaV0sQ+EPFQAAABUAAAAHAAAAAAAAAAAAAACAAQAAAABydWxlLm1kUEsFBgAAAAABAAEANQAAADoAAAAAAA==";
const PY_DEFLATED =
  "UEsDBBQAAAAIANRmaV0AAAAAAgAAAAAAAAAEAAAAZGlyLwMAUEsDBBQAAAAIANRmaV3btxmDFgAAADMAAAALAAAAZGlyL1J1bGUuTURzSU3LSSxJTVEoKs1JVTi8h8uFoAAAUEsBAhQDFAAAAAgA1GZpXQAAAAACAAAAAAAAAAQAAAAAAAAAAAAQAP1BAAAAAGRpci9QSwECFAMUAAAACADUZmld27cZgxYAAAAzAAAACwAAAAAAAAAAAAAAgAEkAAAAZGlyL1J1bGUuTURQSwUGAAAAAAIAAgBrAAAAYwAAAAAA";

/** A Claw that serves the rule tool's download and answers every message. */
class RuleWire extends Wire {
  download: () => Response = () => new Response(zip({ "rule.md": RULE + "\n" }));

  constructor() {
    super((sent: Sent) =>
      sent.rawPath.endsWith("/download")
        ? this.download()
        : json(200, { ok: true, message_id: "m", data: { session_id: "s", message: { message_id: "m" } } }),
    );
  }

  downloads(): Sent[] {
    return this.sent.filter((s) => s.rawPath.endsWith("/download"));
  }

  messages(): Sent[] {
    return this.sent.filter((s) => !s.rawPath.endsWith("/download"));
  }

  lastBody(): Record<string, unknown> {
    return this.messages().at(-1)?.body as Record<string, unknown>;
  }
}

describe("the rule's text", () => {
  it("is the markdown file of the zip", () => {
    assert.equal(ruleText(zip({ "rule.md": "  " + RULE + "\n\n" })), RULE);
    assert.equal(ruleText(Buffer.from(PY_STORED, "base64")), "Write this reply.");
    assert.equal(ruleText(Buffer.from(PY_DEFLATED, "base64")), "Deflated rule ü\n".repeat(3).trim());
    assert.equal(ruleText(zip({ "rule.md": RULE }, true)), RULE);
  });

  const refused: Record<string, Uint8Array> = {
    "not a zip": new TextEncoder().encode("not a zip"),
    "an empty zip": zip({}),
    "two markdown files": zip({ "a.md": "x", "b.md": "y" }),
    "a blank rule": zip({ "rule.md": "   \n" }),
    "a rule too large": zip({ "rule.md": "x".repeat(RULE_MAX_BYTES + 1) }),
    "no markdown file": zip({ "rule.txt": "x" }),
    "a rule that is not UTF-8": zip({ "rule.md": new Uint8Array([0x72, 0xff, 0x0a]) }),
  };
  for (const [what, download] of Object.entries(refused)) {
    it(`what is not one small markdown rule is refused: ${what}`, () => {
      assert.throws(() => ruleText(download), ClawAnswerInvalid);
    });
  }
});

describe("the rule on the wire", () => {
  it("every message carries the rule after the text and the plugin id beside it", async () => {
    const wire = new RuleWire();
    const claw = wire.client({ pluginId: 2, ruleToolId: 17 });
    await claw.sessions.create("ak-a", { text: "hi", idempotencyKey: "idem" });
    await claw.sessions.sendMessage("ak-a", "s", "again");
    const [create, send] = wire.messages();
    assert.ok(create && send);
    assert.equal(create.rawPath, "/v1/sessions");
    assert.equal(send.rawPath, "/v1/sessions/s/messages");
    const created = create.body as { name: string; message: Record<string, unknown> };
    const sent = send.body as Record<string, unknown>;
    assert.equal(created.name, "hi");
    assert.equal(created.message["content"], `hi\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`);
    assert.equal(created.message["pluginId"], 2);
    assert.equal(sent["content"], `again\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`);
    assert.equal(sent["pluginId"], 2);
    assert.ok(!("tools" in sent) && !("tools" in created.message));
  });

  it("the rule is read with the caller's key and kept for later messages", async () => {
    const wire = new RuleWire();
    const claw = wire.client({ pluginId: 2, ruleToolId: 17 });
    await claw.sessions.sendMessage("ak-a", "s", "one");
    await claw.sessions.sendMessage("ak-b", "s", "two");
    assert.deepEqual(
      wire.downloads().map((s) => [s.method, s.rawPath, s.headers.get("authorization")]),
      [["GET", "/v1/tools/17/download", "Bearer ak-a"]],
    );
  });

  it("an old copy is read again", async () => {
    const wire = new RuleWire();
    const clock = new FakeClock();
    const claw = wire.client({ pluginId: 2, ruleToolId: 17, clock });
    await claw.sessions.sendMessage("ak-a", "s", "one");
    clock.now += RULE_TTL_MS - 1000;
    await claw.sessions.sendMessage("ak-a", "s", "two");
    assert.equal(wire.downloads().length, 1);
    clock.now += 2000;
    wire.download = () => new Response(zip({ "rule.md": "A newer rule." }));
    await claw.sessions.sendMessage("ak-a", "s", "three");
    assert.equal(wire.downloads().length, 2);
    assert.equal(wire.lastBody()["content"], `three\n\n${CHANGE}\n\n${RULE_HEADING}\n\nA newer rule.`);
  });
});

describe("a rule that cannot be read", () => {
  const unreadable: Record<string, () => Response> = {
    "a 404": () => json(404, { error: "not found" }),
    "not a zip": () => new Response("<html>not a zip</html>"),
    "two markdown files": () => new Response(zip({ "a.md": "x", "b.md": "y" })),
  };
  for (const [what, download] of Object.entries(unreadable)) {
    it(`a rule that cannot be read does not stop the message: ${what}`, async () => {
      const wire = new RuleWire();
      wire.download = download;
      const logger = new RecordingLogger();
      await wire.client({ pluginId: 2, ruleToolId: 17, logger }).sessions.sendMessage("ak-a", "s", "hi");
      assert.deepEqual(wire.lastBody(), { content: `hi\n\n${CHANGE}`, messageType: "text", pluginId: 2 });
      const line = logger.lines.find((l) => l.message === "could not read the reply-style rule");
      assert.equal(line?.fields["fallback"], "the message goes without it");
    });
  }
});

describe("what rides on a message", () => {
  it("a rule that stops being readable leaves the last copy in use", async () => {
    const wire = new RuleWire();
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    const claw = wire.client({ pluginId: 2, ruleToolId: 17, clock, logger });
    await claw.sessions.sendMessage("ak-a", "s", "one");
    clock.now += RULE_TTL_MS + 1000;
    wire.download = () => new Response("", { status: 500 });
    await claw.sessions.sendMessage("ak-a", "s", "two");
    assert.equal(wire.lastBody()["content"], `two\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`);
    assert.equal(logger.lines.at(-1)?.fields["fallback"], "using the last copy");
  });

  it("with no rule tool nothing is fetched or appended", async () => {
    const wire = new RuleWire();
    await wire.client({ pluginId: 2 }).sessions.sendMessage("ak-a", "s", "hi");
    assert.deepEqual(wire.downloads(), []);
    assert.equal(wire.lastBody()["content"], "hi");
  });

  it("the change summary request is in the message exactly once and last", async () => {
    const wire = new RuleWire();
    await wire.client({ pluginId: 2, ruleToolId: 17 }).sessions.sendMessage("ak-a", "s", "fix the parser");
    const content = wire.lastBody()["content"] as string;
    assert.equal(content.split(CHANGE_HEADING).length - 1, 1);
    assert.ok(content.endsWith(RULE));
    assert.ok(content.indexOf(CHANGE_HEADING) < content.indexOf(RULE_HEADING));
  });

  it("interrupt and decision messages carry no rule", async () => {
    const wire = new RuleWire();
    const claw = wire.client({ pluginId: 2, ruleToolId: 17 });
    await claw.sessions.interrupt("ak-a", "s");
    await claw.sessions.decide("ak-a", "s", "tu1", "approve");
    assert.deepEqual(wire.downloads(), []);
    assert.deepEqual(
      wire.messages().map((s) => s.body),
      [{ messageType: "interrupt" }, { messageType: "decision", extData: { tool_use_id: "tu1", action: "approve" } }],
    );
  });

  it("the reply style rule failing logs the status not the body", async () => {
    const body = '{"ok":false,"error":"internal_error","message":"ak-secret-in-the-echoed-body-0123456789"}';
    const wire = new RuleWire();
    wire.download = () => new Response(body, { status: 500 });
    const logger = new RecordingLogger();
    await wire.client({ ruleToolId: 7, logger }).sessions.sendMessage("ak-a", "s", "hi");
    assert.deepEqual(logger.lines, [
      {
        level: "warn",
        message: "could not read the reply-style rule",
        fields: { tool: 7, error: "Claw returned 500 (internal_error)", fallback: "the message goes without it" },
      },
    ]);
  });
});

describe("a rule archive that lies about its size", () => {
  it("a file that inflates past the size it declares is refused, before more than that is produced", () => {
    const honest = zip({ "rule.md": "x".repeat(5_000_000) });
    const view = new DataView(honest.buffer, honest.byteOffset, honest.byteLength);
    const end = honest.byteLength - 22;
    const central = view.getUint32(end + 16, true);
    view.setUint32(central + 24, 1, true); // the central directory now says one byte
    assert.throws(() => ruleText(honest), ClawAnswerInvalid);
  });

  it("a file whose checksum is not the one recorded is refused", () => {
    const corrupt = zip({ "rule.md": "the rule" }, true);
    const at = corrupt.indexOf(0x74); // the first byte of the stored text ("t")
    corrupt[at] = 0x54;
    assert.throws(() => ruleText(corrupt), ClawAnswerInvalid);
  });

  it("a stored file shorter than it declares is refused", () => {
    const short = zip({ "rule.md": "rule" }, true);
    const view = new DataView(short.buffer, short.byteOffset, short.byteLength);
    const central = view.getUint32(short.byteLength - 22 + 16, true);
    view.setUint32(central + 24, 10, true);
    assert.throws(() => ruleText(short), ClawAnswerInvalid);
  });
});
