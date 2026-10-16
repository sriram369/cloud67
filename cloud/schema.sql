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
