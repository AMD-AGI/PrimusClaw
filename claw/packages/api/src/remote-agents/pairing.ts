// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pairing a machine from the chat: a one-time code instead of a sign-in on the machine.
 *
 * The person asks their own client ("connect my dev environment"); Claw issues a short code bound to them and the client
 * shows it inside one command line. Running that line on the machine is the approval (`claw-connector pair <code>`): the
 * connector trades the code for a credential of its own, and Claw never sees a password or a long secret in the chat.
 *
 *   - A code is 12 characters of Crockford base32 (60 bits), good for {@link PAIRING_TTL_MS} and for one claim. Only its
 *     SHA-256 is stored. A person has at most {@link MAX_LIVE_CODES} live at once; a new one retires the oldest.
 *   - A claim answers a credential (`cpg_` + 32 random bytes, base64url), a *connector grant*, stored as its SHA-256. It is
 *     owned by the person the code was issued to, authenticates on the connector-side routes and nowhere else
 *     (`auth/connector-grant.ts`), and is bound to the connector row it registers. It does not expire: revoking that row
 *     (`/agent off` in the chat, `DELETE /v1/remote-agents/connectors/:cid`, `claw-connector logout`) ends it, and a grant
 *     whose row is revoked answers 401 `revoked`, which stops the connector for good.
 *   - A grant claimed and never used to register is refused an hour after its claim (`pair` registers within seconds) and dropped.
 *
 * The first registration under a grant tells the owner through their assistant, once, which machine was paired and how to
 * disconnect it: the code was shown in a chat, and a person who did not run it should hear about it.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { writeAudit } from "./store.js";

const logger = pino({ name: "remote-agents-pairing" });

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_LIVE_CODES = 3;
export const UNBOUND_GRANT_TTL_MS = 60 * 60 * 1000;
/** What every connector grant starts with, so a request that carries one is recognised before any other credential path. */
export const GRANT_PREFIX = "cpg_";
/** The npm package the pairing command installs. */
export const CONNECTOR_PACKAGE = "@primusclaw/connector";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 12;
const NAME_MAX = 64;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `ABCD-EFGH-JKMN` from random bytes. 60 bits: 12 characters of 5 bits each. */
export function newCode(bytes: Buffer = randomBytes(CODE_CHARS)): string {
  let out = "";
  for (let i = 0; i < CODE_CHARS; i++) out += CROCKFORD[bytes[i]! & 31];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/**
 * The canonical form of a typed code, or null when it cannot be one: case, dashes and spaces do not matter, and the letters
 * Crockford base32 reads as digits (O as 0, I and L as 1) are read so.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_CHARS) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export const hashCode = (normalized: string): string => sha256(`pairing:${normalized}`);
export const hashGrant = (token: string): string => sha256(`grant:${token}`);

/** The one line a person runs on the machine. Installs (or updates) the connector, then pairs and starts it. */
export function pairCommand(server: string, code: string): string {
  const url = server.replace(/\/+$/, "");
  return `npm install -g --no-update-notifier ${CONNECTOR_PACKAGE}@latest && claw-connector pair ${code} --server ${url}`;
}

export async function ensurePairingSchema(q: Querier): Promise<void> {
  await q(`
    CREATE TABLE IF NOT EXISTS claw_remote_pairings (
      code_hash     TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      claimed_at    TIMESTAMPTZ,
      grant_id      UUID
    )
  `);
  await q("CREATE INDEX IF NOT EXISTS idx_remote_pairings_owner ON claw_remote_pairings(owner_user_id, created_at)");
  await q(`
    CREATE TABLE IF NOT EXISTS claw_remote_grants (
      grant_id      UUID PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      device_name   TEXT,
      -- The connector row this grant registered (the latest, when it registered again). NULL until it registers.
      connector_id  UUID,
      notified_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at  TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ
    )
  `);
  await q("CREATE INDEX IF NOT EXISTS idx_remote_grants_connector ON claw_remote_grants(connector_id) WHERE connector_id IS NOT NULL");
}

/** A new code for `owner`, and when it runs out. Retires the owner's oldest live codes beyond {@link MAX_LIVE_CODES}. */
/** Codes one person may be given per minute, by any route (the HTTP route and the assistant's `devenv_pair` alike). */
export const CODES_PER_MINUTE = 6;

export class PairingRateLimited extends Error {
  constructor() { super("too many pairing codes asked for in the last minute"); }
}

export async function createPairing(owner: string, client: string | null, now: Date = new Date(), perMinute: number = CODES_PER_MINUTE): Promise<{ code: string; expires_at: string }> {
  const code = newCode();
  const expires = new Date(now.getTime() + PAIRING_TTL_MS);
  await inTransaction(async (q) => {
    await q("SELECT pg_advisory_xact_lock(7001, hashtext($1))", [`pairings:${owner}`]);
    // Counted from the audit trail, which outlives the codes (spent and expired ones are deleted below).
    const recent = Number((await q(
      `SELECT COUNT(*) AS n FROM claw_remote_audit WHERE owner_user_id = $1 AND action = 'pairing.created'
         AND ts > $2::timestamptz - INTERVAL '1 minute'`, [owner, now],
    )).rows[0].n);
    if (recent >= perMinute) throw new PairingRateLimited();
    // Spent and expired codes say nothing any more; the live ones beyond the newest few are retired.
    await q("DELETE FROM claw_remote_pairings WHERE owner_user_id = $1 AND (claimed_at IS NOT NULL OR expires_at <= $2)", [owner, now]);
    await q(
      `DELETE FROM claw_remote_pairings WHERE code_hash IN (
         SELECT code_hash FROM claw_remote_pairings WHERE owner_user_id = $1 ORDER BY created_at DESC OFFSET $2)`,
      [owner, MAX_LIVE_CODES - 1],
    );
    await q(
      "INSERT INTO claw_remote_pairings (code_hash, owner_user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [hashCode(normalizeCode(code)!), owner, now, expires],
    );
    await writeAudit(q, { owner, actor: owner, client, action: "pairing.created", detail: { expires_at: expires.toISOString() } });
  });
  return { code, expires_at: expires.toISOString() };
}

export type ClaimOutcome = { ok: true; token: string; grantId: string; owner: string; name: string | null } | { ok: false; error: "invalid_code" };

const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NAME_MAX) : "");

/**
 * The name a machine pairs under. A connector that chose no name itself (`pair` without --name or an agents.toml) sends its
 * hostname and an `alternate` (hostname plus its folder or user): when another live machine of the owner's already has the
 * hostname (two folders on one machine, two containers with one hostname), the alternate is used, numbered if that is taken too.
 * Without an alternate the name is kept as it is (the connector's agents.toml says it, and it registers under it).
 */
async function pairedName(q: Querier, owner: string, name: string, alternate: string): Promise<string> {
  if (!name || !alternate || alternate.toLowerCase() === name.toLowerCase()) return name;
  const taken = new Set(((await q(
    "SELECT lower(name) AS n FROM claw_remote_connectors WHERE owner_user_id = $1 AND revoked_at IS NULL", [owner],
  )).rows as Array<{ n: string }>).map((r) => r.n));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 1; i < 100; i++) {
    const tail = i === 1 ? "" : `-${i}`;
    const candidate = `${alternate.slice(0, NAME_MAX - tail.length)}${tail}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/**
 * Trade a code for a connector grant. One answer for a code that never existed, has run out or was used: whoever holds a
 * wrong code learns nothing from which it was.
 */
export async function claimPairing(rawCode: unknown, deviceName: unknown, now: Date = new Date(), alternateName: unknown = null): Promise<ClaimOutcome> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: "invalid_code" };
  const asked = cleanName(deviceName);
  const alternate = cleanName(alternateName);
  const token = `${GRANT_PREFIX}${randomBytes(32).toString("base64url")}`;
  const grantId = randomUUID();
  return inTransaction(async (q) => {
    const row = (await q(
      `UPDATE claw_remote_pairings SET claimed_at = $2, grant_id = $3
        WHERE code_hash = $1 AND claimed_at IS NULL AND expires_at > $2 RETURNING owner_user_id`,
      [hashCode(code), now, grantId],
    )).rows[0] as { owner_user_id: string } | undefined;
    if (!row) return { ok: false, error: "invalid_code" } as const;
    // Under the owner's lock, as a registration counts their machines (`store.ts`): two pairings at once do not both take a name.
    await q("SELECT pg_advisory_xact_lock(7001, hashtext($1))", [`pairings:${row.owner_user_id}`]);
    const name = await pairedName(q, row.owner_user_id, asked, alternate);
    await q(
      "INSERT INTO claw_remote_grants (grant_id, owner_user_id, token_hash, device_name, created_at) VALUES ($1, $2, $3, $4, $5)",
      [grantId, row.owner_user_id, hashGrant(token), name || null, now],
    );
    await writeAudit(q, {
      owner: row.owner_user_id, actor: row.owner_user_id, client: "connector", action: "pairing.claimed",
      detail: { grant_id: grantId, device_name: name || null },
    });
    return { ok: true, token, grantId, owner: row.owner_user_id, name: name || null } as const;
  });
}

export interface GrantRow {
  grant_id: string;
  owner_user_id: string;
  connector_id: string | null;
  created_at: Date;
  revoked_at: Date | null;
  /** The bound connector row was revoked: the grant is over. */
  connector_revoked: boolean;
}

/** The grant `token` names, or null when it names none. */
export async function findGrant(token: string, q: Querier = (t, p) => db.query(t, p)): Promise<GrantRow | null> {
  const row = (await q(
    `SELECT g.grant_id::text AS grant_id, g.owner_user_id, g.connector_id::text AS connector_id, g.created_at, g.revoked_at,
            -- Fails closed: a bound row that is gone counts as revoked.
            (g.connector_id IS NOT NULL AND (c.connector_id IS NULL OR c.revoked_at IS NOT NULL)) AS connector_revoked
       FROM claw_remote_grants g LEFT JOIN claw_remote_connectors c ON c.connector_id = g.connector_id
      WHERE g.token_hash = $1`,
    [hashGrant(token)],
  )).rows[0] as GrantRow | undefined;
  if (!row) return null;
  // Throttled: one write a minute per grant is enough to say when it was last used.
  void q(
    "UPDATE claw_remote_grants SET last_used_at = NOW() WHERE grant_id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')",
    [row.grant_id],
  ).catch((err) => logger.warn({ err: (err as Error)?.message }, "remote_agents.grant_touch_failed"));
  return row;
}

/**
 * After a grant registered a connector (bound to it in `registerConnector`'s transaction): until the owner has been told which
 * machine was paired, they are told. A failure to tell is logged, never the registration's failure, and tried again at the
 * next registration; the notice's key says it once.
 */
export async function notifyPaired(grantId: string, connectorId: string, name: string): Promise<void> {
  const g = (await db.query(
    "SELECT owner_user_id, notified_at FROM claw_remote_grants WHERE grant_id = $1 AND revoked_at IS NULL", [grantId],
  )).rows[0] as { owner_user_id: string; notified_at: Date | null } | undefined;
  if (!g || g.notified_at) return;
  try {
    const told = await pairingPorts.tell({ owner: g.owner_user_id, grantId, connectorId, name });
    if (told) await db.query("UPDATE claw_remote_grants SET notified_at = NOW() WHERE grant_id = $1", [grantId]);
    logger.info({ owner: g.owner_user_id, connectorId, told }, "remote_agents.paired_notice");
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, connectorId }, "remote_agents.paired_notice_failed");
  }
}

/** Unbound grants past their time: the code was claimed and the connector never registered. */
export async function pruneUnboundGrants(): Promise<number> {
  const r = await db.query(
    "DELETE FROM claw_remote_grants WHERE connector_id IS NULL AND created_at < NOW() - make_interval(secs => $1::float8)",
    [UNBOUND_GRANT_TTL_MS / 1000],
  );
  await db.query("DELETE FROM claw_remote_pairings WHERE expires_at < NOW() - INTERVAL '1 day'");
  return r.rowCount ?? 0;
}

const oneLine = (text: unknown, max: number): string => {
  const t = String(text ?? "").replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export const PAIRED_WORDS = {
  zh: (name: string) => `新的开发环境 ${name} 已用配对码连上，现在可以在这里让它干活了。如果不是你本人在那台机器上运行的配对命令，发送 \`/agent off ${name}\` 立即断开它。`,
  en: (name: string) => `Your new dev environment ${name} is paired and connected. If you did not run the pairing command on that machine yourself, send \`/agent off ${name}\` to disconnect it now.`,
};

export function pairedText(name: string, lang: "zh" | "en"): string {
  return PAIRED_WORDS[lang](oneLine(name, NAME_MAX) || "?");
}

/** The language the owner last wrote to their assistant in, Chinese or (failing that) English. */
async function ownerLanguage(q: Querier, owner: string): Promise<"zh" | "en"> {
  const rows = (await q(
    "SELECT content FROM claw_assistant_messages WHERE user_id = $1 ORDER BY received_at DESC LIMIT 5", [owner],
  )).rows as Array<{ content: string }>;
  for (const r of rows) {
    const t = String(r.content ?? "");
    if (/\p{Script=Han}/u.test(t)) return "zh";
    if (/\p{L}{2,}/u.test(t)) return "en";
  }
  return "en";
}

/** What reaches the owner; a test stands in for it. */
export const pairingPorts: {
  tell: (n: { owner: string; grantId: string; connectorId: string; name: string }) => Promise<boolean>;
} = {
  tell: async (n) => {
    if (!CLAW_ASSISTANT_ENABLED) return false;
    const q: Querier = (t, p) => db.query(t, p);
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [n.owner])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return false;
    const { recordSystemNotice } = await import("../assistant/outbound.js");
    await recordSystemNotice({
      userId: n.owner, sessionId, text: pairedText(n.name, await ownerLanguage(q, n.owner)), key: `remote-connector-paired:${n.grantId}`,
    });
    return true;
  },
};
