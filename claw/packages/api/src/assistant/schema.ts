// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind the assistant: one router session per user, the work items the
 * assistant took on, the log of what happened to each, and what the assistant
 * said. Created only when `CLAW_ASSISTANT_ENABLED` is on, so a deployment that
 * leaves it off has the same schema it had before.
 *
 * Nothing here points at a row of `claw_sessions` with a foreign key: a user may
 * delete a session from the web UI, and the item that ran in it, the log and the
 * says all outlive it.
 */
import type pg from "pg";

export async function ensureAssistantSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistants (
      user_id       TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL UNIQUE,
      router_model  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_items (
      item_id            TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      -- The #N the user sees, counted per user.
      seq                INT NOT NULL,
      title              TEXT NOT NULL,
      summary            TEXT NOT NULL DEFAULT '',
      -- in_progress | needs_you | done
      board_state        TEXT NOT NULL,
      -- progress | waiting | ready | answer | blocked | failed | dropped
      last_report_kind   TEXT,
      pending_question   TEXT,
      -- accepted | answered | dropped | stopped, only on a done item
      outcome            TEXT,
      worker_session_id  TEXT NOT NULL,
      -- Fencing token: bumped when a new turn starts, so a report from a turn
      -- that is no longer the current one matches nothing.
      generation         INT NOT NULL DEFAULT 0,
      -- Bumped by every 'ready' report; an acceptance names the version it saw.
      result_version     INT NOT NULL DEFAULT 0,
      accepted_version   INT,
      -- Bumped each time the item enters needs_you.
      attention_seq      INT NOT NULL DEFAULT 0,
      repo               JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at          TIMESTAMPTZ,
      UNIQUE (user_id, seq)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_work_items_board ON claw_work_items(user_id, board_state, updated_at DESC)",
  );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_worker_session ON claw_work_items(worker_session_id)",
  );
  // What the item is: `task`, done by a worker that reports, or `review`, a GitHub review on someone's behalf whose
  // state is read off what it did (`review-items.ts`). `params` is what a review was asked with.
  await client.query("ALTER TABLE claw_work_items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task'");
  await client.query("ALTER TABLE claw_work_items ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb");
  // When the item's worker was first shown the user's memory beyond the item (the index, or an entry recalled): its session
  // keeps what it read from run to run, so from then on it never answers on GitHub without asking (`memory-tools.ts`).
  await client.query("ALTER TABLE claw_work_items ADD COLUMN IF NOT EXISTS memory_reached_at TIMESTAMPTZ");
  // One open review of a pull request at a time, whoever asked: two sessions reviewing it could both write to it.
  // GitHub's names are not case sensitive, and neither is this.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open_review_pr ON claw_work_items(
       lower(params->'pr'->>'owner'), lower(params->'pr'->>'repo'), (params->'pr'->>'number'))
     WHERE kind = 'review' AND board_state <> 'done'`,
  );
  // The reviews a person asked of others, which their own assistant lists read-only (`requester-view.ts`) on every turn.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_work_items_requested_by ON claw_work_items((params->>'requested_by'), updated_at DESC)
     WHERE kind = 'review' AND params ? 'requested_by'`,
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_events (
      id          BIGSERIAL PRIMARY KEY,
      item_id     TEXT NOT NULL,
      -- created | run_started | progress | waiting | ready | answer | blocked | failed | dropped | accepted | stopped
      kind        TEXT NOT NULL,
      -- worker | turn_end | sweep | watchdog | user | router | policy (a review's state, read off what it did)
      source      TEXT NOT NULL,
      generation  INT NOT NULL,
      run_id      TEXT,
      summary     TEXT,
      question    TEXT,
      result      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_work_item_events_item ON claw_work_item_events(item_id, id DESC)",
  );
  // A redelivered start or turn end must not count twice.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_events_run_started
       ON claw_work_item_events(item_id, run_id, kind) WHERE kind = 'run_started'`,
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_events_turn_end
       ON claw_work_item_events(item_id, run_id) WHERE source = 'turn_end'`,
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_says (
      say_id              UUID PRIMARY KEY,
      user_id             TEXT NOT NULL,
      item_id             TEXT,
      item_attention_seq  INT,
      text                TEXT NOT NULL,
      -- Written by the system, not the model, because nobody said anything.
      fallback            BOOLEAN NOT NULL DEFAULT FALSE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at        TIMESTAMPTZ
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_says_user ON claw_assistant_says(user_id, created_at DESC)",
  );
  // At most one system fallback per time an item needed the user. Ordinary says
  // are not limited: the assistant may speak about one item more than once.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_says_fallback
       ON claw_assistant_says(item_id, item_attention_seq) WHERE fallback`,
  );

  // How far an item's delivered files have been announced (`deliveries.ts`): through the report event `event_id`. A report whose
  // announcement failed (the store did not answer) is newer than this, and the sweep announces its files again.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_delivery_checks (
      item_id     TEXT PRIMARY KEY,
      event_id    BIGINT NOT NULL,
      checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // GitHub events for work items (`github-events.ts`): which pull request an item watches, what was seen on it,
  // and what the item's worker answered. Used only while CLAW_ASSISTANT_GITHUB_EVENTS is on.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_subscriptions (
      id               BIGSERIAL PRIMARY KEY,
      item_id          TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INT NOT NULL,
      -- Whether the worker may answer on the pull request as the owner without asking: only the owner, signed in, turns it on.
      reply_allowed    BOOLEAN NOT NULL DEFAULT FALSE,
      -- active | ended
      state            TEXT NOT NULL DEFAULT 'active',
      -- item_closed | pr_merged | pr_closed | user
      end_reason       TEXT,
      -- Nothing created before this is an event: the subscription's start, less a margin for the two clocks.
      since            TIMESTAMPTZ NOT NULL,
      -- Where the next read of comments starts (GitHub's 'since', which is by update time).
      cursor_at        TIMESTAMPTZ NOT NULL,
      polled_at        TIMESTAMPTZ,
      last_error       TEXT,
      failing_since    TIMESTAMPTZ,
      failure_reported BOOLEAN NOT NULL DEFAULT FALSE,
      -- The owner was told that comments by others are held back because their token cannot see who may write to the repository.
      trust_reported   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at         TIMESTAMPTZ
    )
  `);
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_subscriptions_active
       ON claw_work_item_subscriptions(item_id, lower(owner), lower(repo), number) WHERE state = 'active'`,
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_work_item_subscriptions_due ON claw_work_item_subscriptions(polled_at) WHERE state = 'active'",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_github_events (
      -- gh:<subscription>:<kind>:<GitHub's id>: the same comment read twice is the same row.
      event_id      TEXT PRIMARY KEY,
      sub_id        BIGINT NOT NULL,
      item_id       TEXT NOT NULL,
      -- issue_comment | review | review_comment | check_failed | pr_closed
      kind          TEXT NOT NULL,
      github_id     TEXT NOT NULL,
      author        TEXT,
      url           TEXT,
      body          TEXT,
      path          TEXT,
      line          INT,
      -- A review comment's thread: the comment a reply goes under (GitHub takes no reply to a reply).
      reply_to      TEXT,
      head_sha      TEXT,
      occurred_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Set with the worker's queued message, in the same transaction.
      delivered_at  TIMESTAMPTZ,
      delivery_key  TEXT,
      -- The last time a delivery could not be queued (the worker's session gone, say): such items go to the back of the line.
      tried_at      TIMESTAMPTZ,
      dropped_at    TIMESTAMPTZ,
      drop_reason   TEXT
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_work_item_github_events_undelivered
       ON claw_work_item_github_events(item_id, created_at) WHERE delivered_at IS NULL AND dropped_at IS NULL`,
  );
  // Comments held back for an author the owner's token may not check: the poll asks whether the owner was told about them.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_work_item_github_events_unverifiable
       ON claw_work_item_github_events(sub_id) WHERE drop_reason = 'author_unverifiable'`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_pr_replies (
      -- One answer per event, whatever replays it.
      event_id    TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      sub_id      BIGINT NOT NULL,
      run_id      TEXT NOT NULL,
      generation  INT NOT NULL,
      body        TEXT NOT NULL,
      -- posting (written before GitHub is asked) | posted
      state       TEXT NOT NULL,
      attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Which try holds the row: only that try may give it back.
      attempt     INT NOT NULL DEFAULT 1,
      url         TEXT,
      -- GitHub's id for the posted comment.
      comment_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      posted_at   TIMESTAMPTZ
    )
  `);
  // What a router turn may act on: the user's message it answers, as received, with how the request that carried
  // it was authenticated. Written in the transaction that accepts the message, keyed by the id of the turn that
  // will carry it, so a turn can never read a message it does not answer. A report the server queued has no row.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_messages (
      session_id       TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      -- The name the sign-in gave, for what a review signs with ("asked by ...").
      user_name        TEXT,
      content          TEXT NOT NULL,
      -- {kind: "person"} or {kind: "service", client_id, act_sub} when an identity-provider token carried it; NULL otherwise.
      attended_via     JSONB,
      -- What the channel sent beside the text (people, actions, repos, channel_message_id), already bounded.
      channel_context  JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Set when the turn answering it read what a worker wrote (work_recall): from then on that turn's model has read
      -- text nobody vouches for, so it no longer acts for the person.
      untrusted_read_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, message_id)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_messages_received ON claw_assistant_messages(received_at)",
  );
  // A review the person asked of someone else that the router handed to their channel (`review_start`, `review_for_other`): written in
  // the transaction that queues the handoff, and read by `POST /v1/assistant/reviews` when the channel starts it with its id. Whatever the
  // channel sends, such a review merges at all only if the person's message asked for a merge, and is started from one handoff once; how it
  // merges is the reviewer's own review setting's, as for any review asked of them.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_review_handoffs (
      handoff_id       TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL,
      -- "owner/repo#number", lower-cased
      prs              TEXT[] NOT NULL,
      merge            BOOLEAN NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at          TIMESTAMPTZ
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_review_handoffs_pair ON claw_assistant_review_handoffs(user_id, reviewer_user_id, created_at)",
  );
  // The router turn that handed it over (the person's message it answered): the channel answers that message about the review itself, in
  // one message, so the turn says nothing more (`say`, `deliverUnsaidAnswer`). Null on a handoff written before this column.
  await client.query("ALTER TABLE claw_assistant_review_handoffs ADD COLUMN IF NOT EXISTS message_id TEXT");

  // A write the router proposed and the user confirms with one press (`schedules.ts`): creating or cancelling a scheduled task.
  // Nothing is done until the user answers; the row is the card's meaning and its one-time use.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      -- The router session and the turn that proposed it.
      session_id      TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      -- trigger_create | trigger_cancel
      kind            TEXT NOT NULL,
      params          JSONB NOT NULL,
      -- The same proposal twice in one turn is one card.
      dedupe_key      TEXT NOT NULL UNIQUE,
      -- pending | done | denied | expired | failed
      status          TEXT NOT NULL DEFAULT 'pending',
      result          JSONB,
      -- button | command
      decided_via     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL,
      decided_at      TIMESTAMPTZ
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_assistant_confirmations_user ON claw_assistant_confirmations(user_id, status)");

  // Jobs the assistant watches for the user (`job-watch.ts`), and each change of state it saw. Used only while
  // CLAW_ASSISTANT_JOB_EVENTS is on.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_job_watches (
      id               BIGSERIAL PRIMARY KEY,
      user_id          TEXT NOT NULL,
      -- workload (a SaFE workload) | run (a run of the user's in this deployment)
      source           TEXT NOT NULL,
      target           TEXT NOT NULL,
      label            TEXT NOT NULL,
      -- The language the user asked in: what they are told is in it.
      lang             TEXT NOT NULL DEFAULT 'en',
      last_state       TEXT,
      -- How many changes of state were seen: the next one's number, so each is told once.
      transitions      INT NOT NULL DEFAULT 0,
      -- active | ended
      state            TEXT NOT NULL DEFAULT 'active',
      -- finished | not_found | user
      end_reason       TEXT,
      polled_at        TIMESTAMPTZ,
      last_error       TEXT,
      failing_since    TIMESTAMPTZ,
      failure_reported BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at         TIMESTAMPTZ
    )
  `);
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_job_watches_active
       ON claw_assistant_job_watches(user_id, source, target) WHERE state = 'active'`,
  );
  await client.query("CREATE INDEX IF NOT EXISTS idx_assistant_job_watches_due ON claw_assistant_job_watches(polled_at) WHERE state = 'active'");
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_job_events (
      -- job:<watch>:<transition number>
      event_id   TEXT PRIMARY KEY,
      watch_id   BIGINT NOT NULL,
      user_id    TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      detail     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_assistant_job_events_user ON claw_assistant_job_events(user_id, created_at)");
  await ensureObserveSchema(client);
}

/** The places the assistant watches (`observe.ts`), and what it would have done there. */
async function ensureObserveSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_scopes (
      user_id       TEXT NOT NULL,
      scope         TEXT NOT NULL,
      -- observe | auto; auto is set only by a person (see observe.ts)
      mode          TEXT NOT NULL DEFAULT 'observe',
      session_id    TEXT NOT NULL UNIQUE,
      mode_set_at   TIMESTAMPTZ,
      mode_set_via  JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, scope)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_observations (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      scope       TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      run_id      TEXT NOT NULL,
      tool        TEXT NOT NULL,
      args        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_observations_scope ON claw_assistant_observations(user_id, scope, id DESC)",
  );
  // A model that repeats a call, or a Brain that replays it, records it once.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_observations_once
       ON claw_assistant_observations(run_id, tool, md5(args::text))`,
  );
}

/**
 * The tables of model choice (`model-choice.ts`, `model-fallback.ts`), created only with `CLAW_ASSISTANT_MODEL_CHOICE` on, so a
 * deployment that leaves it off has the schema it had before.
 */
export async function ensureModelChoiceSchema(client: pg.PoolClient): Promise<void> {
  // A user's own defaults for their items. No row, or a NULL, is no default: the deployment's applies.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_user_model_prefs (
      user_id        TEXT PRIMARY KEY,
      default_model  TEXT,
      review_model   TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Each turn the gateway refused for want of a key binding and that was run again on the fallback model: one row per refused turn,
  // so it is run again once, and the turn run again is known by its own message id (a router's turn takes its model from here).
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_model_fallbacks (
      session_id        TEXT NOT NULL,
      message_id        TEXT NOT NULL,
      rerun_message_id  TEXT,
      model             TEXT NOT NULL,
      from_model        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, message_id)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_model_fallbacks_rerun ON claw_assistant_model_fallbacks(session_id, rerun_message_id)",
  );
}
