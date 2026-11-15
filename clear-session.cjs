const D = require('better-sqlite3');
const db = new D('store/messages.db');
db.prepare("DELETE FROM sessions WHERE group_folder = 'program-email'").run();
console.log('Session cleared');
db.close();
