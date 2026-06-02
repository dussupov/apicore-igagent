CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id SERIAL PRIMARY KEY,
  ig_user_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  page_id TEXT,
  page_name TEXT,
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  match_mode TEXT NOT NULL DEFAULT 'contains',
  public_replies TEXT[] NOT NULL DEFAULT '{}',
  dm_message TEXT NOT NULL DEFAULT '',
  target_url TEXT,
  use_private_reply BOOLEAN NOT NULL DEFAULT TRUE,
  use_public_reply BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 15,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES instagram_accounts(id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES automation_rules(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ig_user_id TEXT,
  ig_username TEXT,
  media_id TEXT,
  comment_id TEXT,
  comment_text TEXT,
  selected_public_reply TEXT,
  dm_text TEXT,
  status TEXT NOT NULL,
  error TEXT,
  raw_event JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  account_id INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id, bucket)
);
