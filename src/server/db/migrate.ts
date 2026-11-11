import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, parseDatabaseUrl } from './pg.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction, guarded by an advisory lock. */
export async function migrate(pool: Pool, log: (m: string) => void = console.log): Promise<string[]> {
  await pool.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await pool.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(727274)');
    const done = new Set((await q.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      // Split on statement boundaries; migrations avoid functions with embedded semicolons.
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s))) {
        await q.query(stmt);
      }
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      applied.push(f);
      log(`applied ${f}`);
    }
  });
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool(parseDatabaseUrl(url), 2);
  migrate(pool).then((a) => { console.log(a.length ? `${a.length} migration(s) applied` : 'database is up to date'); return pool.end(); })
    .catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
}
