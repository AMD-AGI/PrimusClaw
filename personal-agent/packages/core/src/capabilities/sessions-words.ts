/**
 * Sentences about the remote-agent sessions themselves: switching the chat to an agent's session ("切到 rohan-dev-pod 的 claude")
 * and the words that ask to switch or open a session while a chat is attached to one.
 */
import { flatten } from "./spoken.js";

/** Python's Unicode `\b` before a word character: no word character behind, one ahead. */
const WORD = String.raw`[\p{L}\p{N}_]`;
const BOUNDARY = String.raw`(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`;

function whole(source: string, flags = "iu"): RegExp {
  return new RegExp(`^(?:${source})$`, flags);
}

/**
 * While a chat is attached to an agent's session, what the person says goes to that agent. A sentence about the sessions themselves
 * (switch to another one, open a new one) goes to the assistant instead, which puts the switch or the new session to the person as a
 * button or a card. Whole messages only, and only these shapes, which name a session: "切到 main 分支" or "fix the session timeout
 * bug" still go to the agent.
 */
const CONTROL: readonly RegExp[] = [
  whole(
    String.raw`(?:请|帮我|麻烦)?\s*(?:切到|切换到|换到|切回|回到|连到|连上|连接到|进入|打开)\s*[^\n，,。.!！?？]{0,24}?(?:会话|session)`,
  ),
  // "新开一个会话" alone, or followed by where and what: never a word that goes on from 会话 ("新建一个会话管理器类" is code).
  whole(
    String.raw`(?:请|帮我|麻烦)?\s*(?:新开|新建|另开|再开|开)\s*(?:一个|个)?\s*(?:新的?)?\s*(?:会话|session)` +
      String.raw`(?:(?:\s*[，,]\s*|\s*(?=在|到|用|里|去))[^\n]{1,60}|\s+(?=[~/])[^\n]{1,60})?`,
  ),
  whole(String.raw`(?:please\s+)?(?:switch|go|connect|attach|move)\s+(?:back\s+)?to\s+[^\n.!?]{0,40}?${BOUNDARY}session`),
  // "open a new (codex) session", alone or followed by where and what; only an agent's name before "session".
  whole(
    String.raw`(?:please\s+)?(?:open|start|begin)\s+(?:a\s+)?(?:new|fresh|another|second)\s+(?:(?:claude(?:\s+code)?|codex|cursor|agent)\s+)?session` +
      String.raw`(?:\s*,\s*[^\n]{1,80}|\s+(?:in|at|on|for|with|and|to|under)${BOUNDARY}[^\n]{0,80})?`,
  ),
];

/** Whether the whole message asks to switch the chat to another agent session or to open a new one. */
export function sessionControl(text: string): boolean {
  const flat = flatten(text);
  return flat !== "" && CONTROL.some((pattern) => pattern.test(flat));
}

// The agent word is one of the kinds a connector runs, so "切到 AMD-AGI/PrimusClaw" stays a repository; a machine's name is a host name.
const AGENT_WORD = String.raw`(?<a>claude(?:[\s-]*code)?|codex|cursor)`;
const MACHINE = String.raw`(?<m>[A-Za-z0-9][A-Za-z0-9._-]{0,62})`;
const SWITCH_VERB = String.raw`(?:请|帮我|麻烦)?\s*(?:切到|切换到|切回|切去|换到|连到|连上|连接到|接入|进入|打开)\s*(?:我的)?\s*`;
const SWITCH: readonly RegExp[] = [
  whole(String.raw`${SWITCH_VERB}${MACHINE}\s*(?:上面的|上的|里的|的|上|/|\s)\s*${AGENT_WORD}\s*(?:会话|session)?`),
  whole(String.raw`${SWITCH_VERB}${AGENT_WORD}\s*(?:会话|session)?`),
  whole(
    String.raw`(?:switch|attach|connect|go)(?:\s+back)?\s+to\s+(?:the\s+|my\s+)?(?:${MACHINE}(?:'s|/|\s+))?${AGENT_WORD}` +
      String.raw`(?:\s+(?:on|at)\s+(?<m2>[A-Za-z0-9][A-Za-z0-9._-]{0,62}))?(?:\s+session)?`,
  ),
];

/**
 * `/agent attach MACHINE/AGENT` (or `/agent attach AGENT`) when the whole message asks to switch the chat to an agent's session, as
 * people say it ("切到 rohan-dev-pod 的 claude", "switch to claude on rohan-dev-pod"); else null.
 */
export function switchCommand(text: string): string | null {
  const flat = flatten(text);
  for (const pattern of SWITCH) {
    const groups = pattern.exec(flat)?.groups;
    if (groups === undefined) continue;
    const agent = (groups["a"] ?? "").toLowerCase().replace(/[\s-]*code$/u, "");
    const machine = groups["m"] ?? groups["m2"];
    return machine ? `/agent attach ${machine}/${agent}` : `/agent attach ${agent}`;
  }
  return null;
}
