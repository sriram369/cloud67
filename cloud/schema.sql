CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
  busy_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
  model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id,id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, instruction TEXT NOT NULL, issue_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
  lease TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  summary TEXT, pr_url TEXT, branch_url TEXT
);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
CREATE TABLE IF NOT EXISTS usage (
  bucket TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0
);

-- OpenHands conversations are separate from the preserved prototype history.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, repository TEXT NOT NULL,
  branch TEXT NOT NULL, base_sha TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('inspect','edit')), test_command TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled','needs_input')),
  lease TEXT, lease_until INTEGER, model_hash TEXT, model_calls INTEGER NOT NULL DEFAULT 0,
  runner_url TEXT, answer TEXT, error TEXT, patch TEXT, branch_url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_queue ON turns(status,created_at);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id),
  event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_events_turn ON agent_events(turn_id,id);
CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
