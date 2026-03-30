import { loadConfig } from '../src/config/index.js';
import { initDb, getDb } from '../src/db/index.js';

const config = loadConfig();
initDb(config.dataDir);
const db = getDb();
const rows = db.prepare("SELECT id, status, context_summary, plan, actions FROM proposals").all() as Array<Record<string, unknown>>;
for (const r of rows) {
  console.log('---');
  console.log('id:', (r.id as string).slice(-8), 'status:', r.status);
  console.log('plan:', (r.plan as string)?.slice(0, 80));
  console.log('actions:', (r.actions as string)?.slice(0, 150));
}
console.log(`\nTotal: ${rows.length}`);
