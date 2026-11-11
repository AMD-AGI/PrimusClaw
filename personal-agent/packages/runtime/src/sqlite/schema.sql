
CREATE TABLE IF NOT EXISTS links (
  aad_id TEXT PRIMARY KEY, name TEXT NOT NULL, key_enc BLOB NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending_keys (
  code_hash TEXT PRIMARY KEY, key_enc BLOB NOT NULL, expires_at REAL NOT NULL,
  used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS link_attempts (
  aad_id TEXT NOT NULL, at REAL NOT NULL);
DROP TABLE IF EXISTS link_codes;
CREATE TABLE IF NOT EXISTS sessions (
  aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, updated_at REAL NOT NULL,
  plugin_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (aad_id, scope));
CREATE TABLE IF NOT EXISTS processed (
  activity_id TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS event_claims (
  event_key TEXT PRIMARY KEY, state TEXT NOT NULL, holder TEXT NOT NULL, until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_refs (
  aad_id TEXT PRIMARY KEY, reference_json TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS user_prefs (
  aad_id TEXT PRIMARY KEY, timezone TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS held_events (
  event_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, event_json TEXT NOT NULL, held_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, aad_id TEXT NOT NULL, tool TEXT NOT NULL,
  expires_at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL,
  card_sent INTEGER NOT NULL DEFAULT 1, card_json TEXT,
  PRIMARY KEY (session_id, tool_use_id));
CREATE TABLE IF NOT EXISTS notify_subs (
  aad_id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, subscription_id TEXT NOT NULL,
  secret_enc BLOB NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notify_sub_attempts (
  aad_id TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS turn_answers (
  session_id TEXT PRIMARY KEY, started_at REAL NOT NULL, delivered_at REAL, boot_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '', ended INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL DEFAULT '',
  turn_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS answered_messages (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL, delivered_at REAL NOT NULL, PRIMARY KEY (session_id, message_id));
CREATE TABLE IF NOT EXISTS feedback_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, scene TEXT NOT NULL, created_at REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', issue_number INTEGER, issue_url TEXT NOT NULL DEFAULT '',
  as_comment INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  reporter_name TEXT NOT NULL DEFAULT '', reporter_email TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS feedback_reports_by_user ON feedback_reports (aad_id, scope, session_id, created_at);
CREATE TABLE IF NOT EXISTS feedback_asks (
  aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', asked_at REAL NOT NULL, PRIMARY KEY (aad_id, scope));
CREATE TABLE IF NOT EXISTS feedback_offers (
  offer_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, issue_number INTEGER NOT NULL, session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS feedback_prompts (
  prompt_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_cards (
  prompt_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, scope TEXT NOT NULL, teams_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS onboarding_cards_by_user ON onboarding_cards (aad_id, scope, created_at);
CREATE TABLE IF NOT EXISTS onboarding_dms (
  aad_id TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending_requests (
  aad_id TEXT PRIMARY KEY, scope TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL,
  reference_json TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS github_confirmations (
  confirmation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor_aad TEXT NOT NULL, requester_aad TEXT NOT NULL,
  repo TEXT NOT NULL, pr INTEGER NOT NULL, reference_json TEXT NOT NULL, expires_at REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merge', event TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS acting_sessions (
  session_id TEXT PRIMARY KEY, requester_aad TEXT NOT NULL, actor_aad TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS review_notices (session_id TEXT, actor_aad TEXT, requester_aad TEXT, pull TEXT, delivered INTEGER,
    reason TEXT, at REAL);
CREATE TABLE IF NOT EXISTS assistant_messages (
  channel_message_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, actions TEXT NOT NULL, sent_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS teams_users (
  teams_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS github_notices (
  aad_id TEXT NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (aad_id, kind));
CREATE TABLE IF NOT EXISTS recent_repos (
  aad_id TEXT NOT NULL, repo_key TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL,
  PRIMARY KEY (aad_id, repo_key, branch));
CREATE TABLE IF NOT EXISTS pending_repo (
  aad_id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', set_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS session_history (
  aad_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '', last_at REAL NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (aad_id, session_id));
CREATE TABLE IF NOT EXISTS remote_state (
  aad_id TEXT PRIMARY KEY, session_id TEXT, connector_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '',
  agent_label TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL DEFAULT '', turn_open INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT '',
  modes_json TEXT NOT NULL DEFAULT '[]', listing_json TEXT NOT NULL DEFAULT '[]', updated_at REAL NOT NULL,
  unattended INTEGER, mode_flags_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS remote_session_names (
  session_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', conversation_ref TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL, acp_session_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS remote_permissions (
  session_id TEXT NOT NULL, action_id TEXT NOT NULL, aad_id TEXT NOT NULL, tool TEXT NOT NULL,
  options_json TEXT NOT NULL, expires_at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL,
  PRIMARY KEY (session_id, action_id));
CREATE TABLE IF NOT EXISTS personal_clicks (
  aad_id TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_cards (
  card_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,
  can_accept INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS auto_replies (
  aad_id TEXT NOT NULL, item_id TEXT NOT NULL, pull TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (aad_id, item_id));
CREATE TABLE IF NOT EXISTS assistant_action_cards (
  card_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, channel_message_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_confirm_cards (
  card_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, confirmation_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS asker_follows (
  item_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, review_json TEXT NOT NULL, reference_json TEXT NOT NULL,
  said TEXT NOT NULL DEFAULT '', reviewer_told INTEGER NOT NULL DEFAULT 0, deadline REAL NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS observed_groups (
  conversation_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, scope TEXT NOT NULL, reference_json TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', on_since REAL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS observe_cards (
  card_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  tool TEXT NOT NULL, args TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
  created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS observe_cards_by_suggestion ON observe_cards (aad_id, run_id, seq);
CREATE TABLE IF NOT EXISTS group_context_off (
  conversation_id TEXT PRIMARY KEY, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS bound_users (
  aad_id TEXT PRIMARY KEY, claw_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, updated_at REAL NOT NULL);
