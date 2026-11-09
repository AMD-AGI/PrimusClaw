// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_USER_LIMITS,
  InboundStats,
  MessageRateLimiter,
  limitsText,
  noMetrics,
  userLimits,
  waitWords,
  type LogFields,
  type Logger,
  type MetricsPort,
} from "../../src/index.js";
import { FakeClock } from "../../../../test-support/index.js";

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields: LogFields | undefined }> = [];
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: "error", message, fields });
  }
  child(): Logger {
    return this;
  }
}

test("the limiter does not count refused messages and forgets idle users", async () => {
  const clock = new FakeClock();
  const limiter = new MessageRateLimiter(2, 10, clock);
  assert.deepEqual(
    Array.from({ length: 5 }, () => limiter.check("u").allowed),
    [true, true, false, false, false],
  );
  const verdicts = [limiter.check("u"), limiter.check("u")];
  assert.ok(!verdicts.some((v) => v.notify)); // told once for the burst
  await clock.advance(10_000);
  assert.ok(limiter.check("u").allowed); // refusals did not push the window out
  await clock.advance(100_000);
  limiter.prune();
  assert.equal(limiter.remembered, 0);
});

test("the first refusal of a burst is told, with the seconds until one more fits", async () => {
  const clock = new FakeClock();
  const limiter = new MessageRateLimiter(1, 60, clock);
  assert.ok(limiter.check("u").allowed);
  await clock.advance(15_000);
  const refused = limiter.check("u");
  assert.deepEqual(refused, { allowed: false, notify: true, retryAfterSeconds: 45 });
  assert.equal(limiter.check("u").notify, false);
  await clock.advance(45_000);
  assert.ok(limiter.check("u").allowed); // a new burst
  await clock.advance(1_000);
  assert.equal(limiter.check("u").notify, true); // ... is told again
  assert.equal(limiter.limit, 1);
  assert.equal(limiter.windowSeconds, 60);
});

test("the limiter prunes idle people every thousand checks", async () => {
  const clock = new FakeClock();
  const limiter = new MessageRateLimiter(5, 1, clock);
  limiter.check("idle");
  await clock.advance(2_000);
  for (let i = 0; i < 998; i++) limiter.check(`u${String(i % 3)}`);
  assert.equal(limiter.remembered, 4);
  limiter.check("u0"); // the thousandth
  assert.equal(limiter.remembered, 3);
});

test("waiting is said in seconds under two minutes, else in minutes rounded up", () => {
  assert.equal(waitWords(0.2), "1 second");
  assert.equal(waitWords(1.5), "2 seconds");
  assert.equal(waitWords(119), "119 seconds");
  assert.equal(waitWords(120), "2 minutes");
  assert.equal(waitWords(121), "3 minutes");
  assert.equal(waitWords(0.2, "zh"), " 1 秒");
  assert.equal(waitWords(300, "zh"), " 5 分钟");
});

test("the refusals say what was not done, in both languages", () => {
  assert.equal(
    limitsText.in("en").rateLimited({ s: "s", wait: "3 seconds" }),
    "You are sending messages faster than I can take them, so I did not pass on your last messages. Wait 3 seconds " +
      "and send it again. If a task is running and you want it to end, send /stop (it always works).",
  );
  assert.equal(
    limitsText.in("zh").rateLimited({ s: "", wait: " 3 秒" }),
    "你发消息太快了，我没有转交你刚才的消息。请等 3 秒再发一次。要结束正在运行的任务，发 /stop（它总是有效）。",
  );
  assert.equal(
    limitsText.in("en").concurrencyLimited({ running: 12, what: " (a review)" }),
    "You already have 12 tasks running, which is the most I run at the same time for one person, so I did not start " +
      "this one (a review). Send it again when one of them has finished, or send /stop in that chat to end it.",
  );
  assert.equal(
    limitsText.in("zh").concurrencyLimited({ running: 2, what: "" }),
    "你已经有 2 个任务在运行，这是我同时为一个人运行的上限，所以这一个没有开始。等其中一个完成后再发，或者在那个聊天里发 /stop 结束它。",
  );
});

test("the user limits have safe defaults and refuse a value that is not a positive whole number", () => {
  assert.deepEqual(userLimits(), { messageLimit: 20, messageWindowSeconds: 60, maxConcurrentTasks: 12 });
  assert.deepEqual(userLimits({ messageLimit: 7, messageWindowSeconds: 30, maxConcurrentTasks: 2 }), {
    messageLimit: 7,
    messageWindowSeconds: 30,
    maxConcurrentTasks: 2,
  });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => userLimits({ ...DEFAULT_USER_LIMITS, maxConcurrentTasks: bad }), /max_concurrent_tasks/);
    assert.throws(() => userLimits({ ...DEFAULT_USER_LIMITS, messageLimit: bad }), /message_limit/);
    assert.throws(() => userLimits({ ...DEFAULT_USER_LIMITS, messageWindowSeconds: bad }), /message_window_seconds/);
  }
});

test("the inbound counters log one line per interval and start again from zero", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const counted: string[] = [];
  const metrics: MetricsPort = {
    ...noMetrics,
    processed: (lag, handle, ok) => counted.push(`processed ${String(lag)} ${String(handle)} ${String(ok)}`),
    limited: (reason) => counted.push(`limited ${reason}`),
    filesDropped: (path, count) => counted.push(`dropped ${path} ${String(count)}`),
  };
  const stats = new InboundStats(clock, logger, metrics, 60);
  stats.processed(5000, 250, true);
  stats.processed(1000, 250, true);
  stats.limited("user_limit");
  stats.processed(1000, 250, false);
  stats.filesDropped("session", 2);
  await clock.advance(60_000);
  stats.processed(0, 250, true); // the interval is over: one line
  assert.equal(logger.lines.length, 1);
  assert.deepEqual(logger.lines[0], {
    level: "info",
    message: "inbound_stats",
    fields: {
      interval_seconds: 60,
      handled: 4,
      failed: 1,
      lag_max_ms: 5000,
      lag_avg_ms: 1750,
      handle_max_ms: 250,
      handle_avg_ms: 250,
      rate_limited: 1,
      concurrency_limited: 0,
    },
  });
  assert.equal(stats.handled, 0); // counted again from zero
  assert.deepEqual(counted, [
    "processed 5000 250 true",
    "processed 1000 250 true",
    "limited user_limit",
    "processed 1000 250 false",
    "dropped session 2",
    "processed 0 250 true",
  ]);
});

test("an interval with nothing in it logs nothing, and a refusal alone is logged", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const stats = new InboundStats(clock, logger);
  stats.flush();
  assert.equal(logger.lines.length, 0);
  stats.limited("concurrency_limit");
  stats.processed(null, 10, true);
  assert.equal(stats.snapshot().lag_max_ms, 0);
  await clock.advance(61_000);
  stats.flushDue();
  assert.equal(logger.lines[0]?.fields?.["concurrency_limited"], 1);
  assert.equal(new InboundStats(clock, logger).snapshot().lag_avg_ms, 0);
});
