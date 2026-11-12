// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One run of the conformance kit: the surface's real worker (its `buildWorker`, so `assembleWorker` with its adapter) on
 * the loopback, with the fake Claw (`KitClaw`), its store in a fresh temporary directory, and the surface's driver. Every
 * step goes the product path: a person links with the console's code and `/link`, writes through the surface's own
 * inbound side, and Claw's events arrive signed at `/claw-events/<route>`.
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sign } from "@primusclaw/personal-agent-runtime";
import type { Worker, WorkerEnv } from "@primusclaw/personal-agent-runtime/worker";

import { RecordingLogger } from "../recording-logger.js";
import { tempDir } from "../store.js";
import { KitClaw, PLATFORM, clawUserOf, keyOf } from "./claw.js";
import type { ChatDriver, KitChat, KitPerson, SeenMessage, SurfaceUnderTest } from "./driver.js";

/** A person of the kit, named after the test they take part in, and their 1:1 chat with the bot. */
export function person(name: string): KitPerson {
  return { id: `kit-${name}`, name: name.charAt(0).toUpperCase() + name.slice(1) };
}

export function dmOf(who: KitPerson): KitChat {
  return { id: `${who.id}-dm`, kind: "personal" };
}

/** How long the kit waits for something to reach a chat. */
const WAIT_MS = 5000;

export interface RunOptions {
  /**
   * The people whose 1:1 messages go to their assistant, whose replies come back as Claw's events (ASSISTANT_ENABLED with
   * ASSISTANT_USERS); everyone else's start plain chat turns. None: the assistant is off.
   */
  readonly assistant?: readonly KitPerson[];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return typeof address === "object" && address !== null ? address.port : 0;
}

/** Core's settings for a run (the names are the worker's, whatever the surface). */
async function coreEnv(claw: KitClaw, dir: string, port: number, options: RunOptions): Promise<WorkerEnv> {
  return {
    TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=",
    TEAMS_DB_PATH: join(dir, "state.db"),
    SECRETS_SOURCE: "env",
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: claw.url,
    SAFE_API_URL: claw.url + PLATFORM,
    PROACTIVE_ENABLED: "1",
    NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${String(port)}/claw-events`,
    ASSISTANT_ENABLED: options.assistant?.length ? "1" : "0",
    ASSISTANT_USERS: (options.assistant ?? []).map((p) => p.id).join(","),
    PORT: String(port),
    METRICS_PORT: String(await freePort()),
  };
}

export class KitRun {
  private stopped: Promise<number> | undefined;

  private constructor(
    readonly claw: KitClaw,
    readonly driver: ChatDriver,
    readonly baseUrl: string,
    readonly logger: RecordingLogger,
    private readonly worker: Worker,
    private readonly running: Promise<void>,
    private readonly removeDir: () => void,
  ) {
    // (a worker that fails while the tests run is reported by `stop`, which awaits `running`; until then it is not unhandled)
    running.catch(() => undefined);
  }

  /** Build the surface's worker and run it until `stop`; resolves once it answers /healthz. */
  static async start(sut: SurfaceUnderTest, options: RunOptions = {}): Promise<KitRun> {
    const claw = await KitClaw.start();
    const dir = tempDir();
    let driver: ChatDriver | undefined;
    let run: KitRun | undefined;
    try {
      driver = await sut.open();
      const port = await freePort();
      const logger = new RecordingLogger();
      const env = { ...(await coreEnv(claw, dir.path, port, options)), ...driver.env };
      const worker = await driver.buildWorker(env, () => ({}), { logger });
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      run = new KitRun(claw, driver, baseUrl, logger, worker, worker.run(), dir.remove);
      const up = async () => (await fetch(`${baseUrl}/healthz`).catch(() => undefined))?.ok === true;
      await run.until(up, "/healthz");
      driver.attach(baseUrl);
      return run;
    } catch (error) {
      // (a start that failed leaves nothing open: the worker if it was built, the fakes, the directory)
      if (run !== undefined) await run.stop().catch(() => undefined);
      else {
        await Promise.allSettled([claw.close(), driver?.close()]);
        dir.remove();
      }
      throw error;
    }
  }

  /** Wait until `check` holds; fails naming `what`, with what the chats were shown and the worker's log. */
  async until(check: () => boolean | Promise<boolean>, what: string, ms = WAIT_MS): Promise<void> {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error(
      `timed out waiting for ${what}\nshown: ${JSON.stringify(this.driver.seen(), null, 1)}\n${this.logger.dump()}`,
    );
  }

  /** Wait for a message in `chat` that `match` accepts, after the first `after` of the chat's; that message. */
  async shown(chat: KitChat, match: (m: SeenMessage) => boolean, what: string, after = 0): Promise<SeenMessage> {
    let found: SeenMessage | undefined;
    await this.until(() => {
      found = this.driver.seen(chat).slice(after).find(match);
      return found !== undefined;
    }, what);
    return found as SeenMessage;
  }

  /**
   * `person` links their chat the way a person does: the console posts their key to the worker's link route, and they
   * type the code it gave as `/link CODE` in their 1:1 chat. Resolves once the chat said they are connected, and they
   * turned quiet hours off (`/quiet off`): a new person has them on (22:00-08:00 in the default zone), and on the real
   * clock a notice or an approval Claw pushes would be held instead of delivered whenever the kit runs at night there.
   */
  async link(person: KitPerson, chat: KitChat): Promise<void> {
    const answer = await fetch(`${this.baseUrl}/primus-claw-agent/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: keyOf(person.id) }),
    });
    const { code } = (await answer.json()) as { code?: string };
    if (answer.status !== 200 || !code) throw new Error(`the link route answered ${String(answer.status)}`);
    const before = this.driver.seen(chat).length;
    await this.driver.say(chat, person, `/link ${code}`);
    await this.shown(chat, (m) => /connected|linked/i.test(m.text), "the chat to say it is connected", before);
    const linked = this.driver.seen(chat).length;
    await this.driver.say(chat, person, "/quiet off");
    await this.shown(chat, (m) => /quiet hours are off/i.test(m.text), "the chat to say quiet hours are off", linked);
  }

  /** The subscription `person`'s worker made with Claw (its latest). */
  subscriptionOf(person: KitPerson) {
    return this.claw.subscriptions.filter((s) => s.personId === person.id).at(-1);
  }

  /** Claw posts `event` for `person` the way it posts every event: signed, to the route of their subscription. */
  async event(person: KitPerson, event: Readonly<Record<string, unknown>>): Promise<{ status: number; body: unknown }> {
    const sub = this.subscriptionOf(person);
    if (sub === undefined) throw new Error(`${person.name} has no subscription`);
    const webhook = typeof sub.body["url"] === "string" ? sub.body["url"] : "";
    const route = webhook.split("/").at(-1) ?? "";
    const body = Buffer.from(JSON.stringify({ user_id: clawUserOf(person.id), ...event }));
    const stamp = String(Math.floor(Date.now() / 1000));
    const answer = await fetch(`${this.baseUrl}/claw-events/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claw-timestamp": stamp,
        "x-claw-signature": sign(sub.secret, stamp, body),
      },
      body,
    });
    return { status: answer.status, body: (await answer.json()) as unknown };
  }

  /**
   * Stop the worker (`stop` and `run` both return) and close everything the run opened; how long stopping took, in ms. A
   * second call waits for the first.
   */
  stop(): Promise<number> {
    this.stopped ??= this.stopOnce();
    return this.stopped;
  }

  private async stopOnce(): Promise<number> {
    const started = performance.now();
    try {
      await this.worker.stop();
      await this.running;
      return performance.now() - started;
    } finally {
      await Promise.allSettled([this.claw.close(), this.driver.close()]);
      this.removeDir();
    }
  }
}
