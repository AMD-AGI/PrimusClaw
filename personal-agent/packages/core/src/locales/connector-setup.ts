// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** How to connect a machine and upgrade its connector (`remote/connector/setup.ts`). */
export const connectorSetupText = defineCatalog({
  en: {
    noMachine: "You have no machine connected.",
    /** Between the first line and `runOn`. */
    sep: " ",
    runOn: "On the machine you want to use (Node.js 22 or newer), run:",
    after:
      "`init` writes agents.toml and prints where: set `roots` there to the folders an agent may work in (the sample uses " +
      "`~/work`). `login` prints a link and a code: open it where you are signed in and confirm. Then send /agents to see the " +
      "machine.",
    /** What differs per system, one line each. */
    notes:
      "- Linux: if `service install` asks, also run `loginctl enable-linger $USER` once; in a container or dev pod without " +
      "systemd, add the two lines it prints to crontab or the container's startup command.\n" +
      "- macOS: the same commands; launchd keeps it running.\n" +
      "- Windows: run the same commands inside WSL (for example Ubuntu).\n" +
      "- npm says `EACCES`: run `npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on your `PATH` instead of " +
      "using sudo.",
    upgrade: (p: { command: string }) => `On that machine, run \`${p.command}\` to upgrade it and restart it.`,
    versionUnsupported: (p: { version: string }) => `Its connector (${p.version}) is too old for a new session.`,
    versionOutdated: (p: { version: string }) => `Its connector (${p.version}) is out of date.`,
    offlineHint:
      "On that machine, run `claw-connector status` to see why, then `claw-connector service install` to start it again.",
  },
  zh: {
    noMachine: "你还没有连接任何机器。",
    sep: "",
    runOn: "在要使用的机器上（需要 Node.js 22 及以上）依次运行：",
    after:
      "`init` 会生成 agents.toml 并打印位置：把其中的 `roots` 改成允许 agent 工作的目录（示例是 `~/work`）。`login` 会打印一个链接和" +
      "验证码：在已登录的浏览器里打开并确认。之后发 /agents 就能看到这台机器。",
    notes:
      "- Linux：`service install` 若提示，再运行一次 `loginctl enable-linger $USER`；容器或 dev pod 没有 systemd 时，把它打印的两行加进 " +
      "crontab 或容器启动命令。\n" +
      "- macOS：同样的命令，由 launchd 常驻。\n" +
      "- Windows：在 WSL（例如 Ubuntu）里运行同样的命令。\n" +
      "- npm 报 `EACCES`：先 `npm config set prefix ~/.npm-global`，把 `~/.npm-global/bin` 加进 `PATH`，不要用 sudo。",
    upgrade: (p) => `在那台机器上运行 \`${p.command}\` 升级并重启它。`,
    versionUnsupported: (p) => `连接器版本 ${p.version} 太旧，不能开新会话。`,
    versionOutdated: (p) => `连接器版本 ${p.version} 较旧，建议升级。`,
    offlineHint:
      "在那台机器上运行 `claw-connector status` 看原因，再运行 `claw-connector service install` 重新启动它。",
  },
});
