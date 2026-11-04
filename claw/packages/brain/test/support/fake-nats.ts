// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The subject a DecisionDispatcher subscribes to, fed by hand: `answer` delivers one message on it. */
export function fakeNats() {
  const queue: Array<{ data: Uint8Array } | null> = [];
  let wake: (() => void) | null = null;
  const sc = new TextEncoder();
  const nc = {
    subscribe(subject: string) {
      nc.subjects.push(subject);
      return {
        async drain() { queue.push(null); wake?.(); },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (!queue.length) await new Promise<void>((r) => { wake = r; });
            const next = queue.shift();
            if (next === null) return;
            yield next as { data: Uint8Array };
          }
        },
      };
    },
    subjects: [] as string[],
    answer(msg: Record<string, unknown>) { queue.push({ data: sc.encode(JSON.stringify(msg)) }); wake?.(); },
  };
  return nc;
}
