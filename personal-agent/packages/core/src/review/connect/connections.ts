// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What /whoami says the person is connected to: SaFE, GitHub (what the bot reads it with), the deployment's own lines, memory. */

import type { GithubConnection } from "../../claw/model.js";
import type { GithubState } from "../../ports/github.js";

/** A part that could not be read just now. */
export const UNKNOWN = Symbol("unknown");

export interface ConnectionsInput {
  /** The SaFE account the chat is linked to; null when it could not be read. */
  readonly safe: { readonly name: string } | null;
  /** The binding at the identity service; null: none (or no `/github` here); UNKNOWN. */
  readonly githubState: GithubState | null | typeof UNKNOWN;
  /** Claw's answer; null with `connectionKnown` for a Claw that cannot say, null without it when it could not be asked. */
  readonly connection: GithubConnection | null;
  readonly connectionKnown: boolean;
  readonly githubPart: boolean;
  /** (enabled, available), or UNKNOWN. */
  readonly memory: readonly [boolean, boolean] | typeof UNKNOWN;
  readonly memoryPage: string;
  readonly zh: boolean;
  /** The lines a deployment's integrations add. */
  readonly extraLines: readonly string[];
}

export function connectionsText(p: ConnectionsInput): string {
  const lines = [p.zh ? "连接状态：" : "Connections:"];
  if (p.safe === null) lines.push(p.zh ? "- SaFE：暂时读不到" : "- SaFE: could not be read just now");
  else lines.push(p.zh ? `- SaFE：已连接（${p.safe.name}）` : `- SaFE: connected (${p.safe.name})`);
  const github = githubWords(p.githubState, p.connection, p.connectionKnown, p.githubPart, p.zh);
  lines.push(p.zh ? `- GitHub：${github}` : `- GitHub: ${github}`, ...p.extraLines);
  if (p.memory === UNKNOWN) lines.push(p.zh ? "- 记忆：暂时读不到" : "- Memory: could not be read just now");
  else if (!p.memory[1]) lines.push(p.zh ? "- 记忆：这个部署没有" : "- Memory: not on this deployment");
  else if (p.memory[0]) lines.push(p.zh ? "- 记忆：开" : "- Memory: on");
  else lines.push(p.zh ? `- 记忆：关，在这里打开：${p.memoryPage}` : `- Memory: off; turn it on at ${p.memoryPage}`);
  return lines.join("\n");
}

function unsaid(known: boolean, zh: boolean): string {
  if (zh) return known ? "PrimusClaw 没有告诉我它用什么读你的 GitHub" : "暂时问不到 PrimusClaw 用什么读你的 GitHub";
  return known
    ? "PrimusClaw does not say what it reads your GitHub with"
    : "PrimusClaw could not be asked what it reads your GitHub with";
}

/** Only the /github bind binding is reported when Claw does not say what it reads with (never "not connected"). */
function bindingOnly(state: GithubState | null, who: string, known: boolean, part: boolean, zh: boolean): string {
  const why = unsaid(known, zh);
  if (state !== null && state.bound && !state.expired)
    return zh ? `已用 \`/github bind\` 连接${who}（${why}）` : `connected${who} with \`/github bind\` (${why})`;
  if (state?.bound && state.expired)
    return zh ? `\`/github bind\` 的授权已过期（${why}）` : `the \`/github bind\` authorization has expired (${why})`;
  if (part && state !== null)
    return zh ? `没有用 \`/github bind\` 连接（${why}）` : `not connected with \`/github bind\` (${why})`;
  return why;
}

function withConnection(
  state: GithubState | null,
  connection: GithubConnection,
  who: string,
  part: boolean,
  zh: boolean,
): string {
  if (state?.bound && state.expired)
    return zh
      ? "授权已过期，发 `/github bind` 重新连接"
      : "the authorization has expired; send `/github bind` to connect it again";
  if (state !== null && state.bound && !state.expired) {
    if (connection.bindingReads)
      return zh
        ? `已连接${who}，但 PrimusClaw 暂时用不了它读 GitHub`
        : `connected${who}, but PrimusClaw cannot read GitHub with it just now`;
    return zh
      ? `已连接${who}（只用于代审；要让我读你的 GitHub，在 PrimusClaw 设置里保存一个 GH_TOKEN）`
      : `connected${who} (for reviews only; for me to read your GitHub, keep a GH_TOKEN in your PrimusClaw settings)`;
  }
  if (part && connection.bindingReads)
    return zh ? "未连接，发 `/github bind` 连接" : "not connected; send `/github bind` to connect it";
  return zh
    ? "未连接，可以在 PrimusClaw 设置里保存一个 GH_TOKEN"
    : "not connected; keep a GH_TOKEN in your PrimusClaw settings";
}

function githubWords(
  state: GithubState | null | typeof UNKNOWN,
  connection: GithubConnection | null,
  known: boolean,
  part: boolean,
  zh: boolean,
): string {
  const login = connection?.login || (state !== null && state !== UNKNOWN ? state.login : "");
  const who = login ? ` \`${login}\`` : "";
  if (connection?.readsWith === "binding") {
    return zh
      ? `已连接${who}，我用它以你的身份读 GitHub（PR、CI、issue）`
      : `connected${who}; I read your GitHub with it, as you (pull requests, CI, issues)`;
  }
  if (connection?.readsWith === "env") {
    return zh
      ? "已连接，我用你在 PrimusClaw 设置里保存的 GH_TOKEN 读 GitHub"
      : "connected; I read your GitHub with the GH_TOKEN in your PrimusClaw settings";
  }
  if (state === UNKNOWN) return zh ? "暂时读不到" : "could not be read just now";
  if (connection === null) return bindingOnly(state, who, known, part, zh);
  return withConnection(state, connection, who, part, zh);
}
