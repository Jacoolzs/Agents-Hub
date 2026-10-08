export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  membership_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'maintainer', 'collaborator', 'reader')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'disconnected')),
  last_cursor TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  recipient_agent_ids TEXT NOT NULL, -- JSON array string
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS status_reports (
  status_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  progress TEXT NOT NULL CHECK(progress IN ('started', 'in_progress', 'blocked', 'completed')),
  decision TEXT,
  blocked_by TEXT,
  next_step TEXT,
  reported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_reports_project_agent ON status_reports(project_id, agent_id);

CREATE TABLE IF NOT EXISTS workspace_locks (
  lock_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  owner_agent_id TEXT NOT NULL,
  paths TEXT NOT NULL, -- JSON array string
  reason TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_locks_project ON workspace_locks(project_id, expires_at);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL, -- JSON string
  UNIQUE(project_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, sequence);

CREATE TABLE IF NOT EXISTS audit_entries (
  audit_id TEXT PRIMARY KEY,
  project_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  result TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  audience TEXT NOT NULL,
  scopes TEXT NOT NULL, -- JSON array string
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ws_tickets (
  ticket_id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_hash ON ws_tickets(ticket_hash);
`;
