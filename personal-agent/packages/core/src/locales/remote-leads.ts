// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The leads a connector's reason is said after (`remote/connector/reasons.ts` `ended`), as [Chinese, English]: a reason may be
 * said in both languages at once when the chat's is not known.
 */
type Pair = readonly [zh: string, en: string];

export const remoteLeads = {
  sessionEnded: ["会话已结束", "The session ended"],
  couldNotStart: ["会话没能启动", "The session could not start"],
  turnIncomplete: ["这一轮没有完成", "The turn did not complete"],
  modeNotSwitched: ["模式没有切换", "The mode was not switched"],
  notSwitchedTo: (mode: string): Pair => [`没有切到 \`${mode}\``, `The agent did not switch to \`${mode}\``],
} as const satisfies Readonly<Record<string, Pair | ((mode: string) => Pair)>>;
