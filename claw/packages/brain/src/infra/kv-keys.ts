// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every key a KV `keys()` listing yields, collected before any of them is read.
 *
 * The listing has to be drained before the bucket is asked anything else. The
 * nats.js client this service runs ends the iteration early when another KV
 * operation is awaited while it is still open: a walk that `get`s each key as
 * it arrives reads the first key and then sees the listing finish, so it
 * answers "not there" about every key after the first. Measured against the
 * deployed client: eight keys listed when nothing else was awaited, one when a
 * `get` ran inside the loop, every time.
 *
 * A miss there is not cosmetic. A replica that did not issue a sandbox's token
 * denied it, a keepalive sweep saw one sandbox out of the whole fleet, and a
 * retry-pending lookup stopped at the first entry it could not use.
 */
export async function drainKeys(keys: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const key of keys) out.push(key);
  return out;
}
