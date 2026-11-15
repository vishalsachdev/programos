const Database = require('better-sqlite3');

// Check both DBs
for (const dbPath of ['store/messages.db', 'data/nanoclaw.db']) {
  const db = new Database(dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(dbPath + ':', tables.map(t => t.name));
  db.close();
}

// Seed the webhook group into store/messages.db (where initDatabase writes)
const db = new Database('store/messages.db');

db.prepare(`INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'webhook-email@program',
  'Program Email',
  'program-email',
  '',
  new Date().toISOString(),
  JSON.stringify({
    additionalMounts: [{
      hostPath: '/srv/program-repo',
      containerPath: 'program-repo',
      readonly: false
    }],
    timeout: 600000
  }),
  0,
  0
);

db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time, channel, is_group)
  VALUES (?, ?, ?, ?, ?)`).run(
  'webhook-email@program',
  'Program Email',
  new Date().toISOString(),
  'webhook',
  0
);

console.log('\nRegistered group:', db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('webhook-email@program'));
console.log('Chat entry:', db.prepare('SELECT * FROM chats WHERE jid = ?').get('webhook-email@program'));
db.close();
