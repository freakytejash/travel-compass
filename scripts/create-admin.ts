// Promote an existing, email-verified account to administrator:  npm run db:create-admin -- owner@example.com
import { Pool, parseDatabaseUrl } from '../src/server/db/pg.ts';

const email = process.argv[2];
if (!email || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=... npm run db:create-admin -- <email>'); process.exit(1); }
const db = new Pool(parseDatabaseUrl(process.env.DATABASE_URL), 1);
const r = await db.query<{ id: string }>(`UPDATE users SET role='admin', updated_at=now() WHERE lower(email)=lower($1) AND email_verified_at IS NOT NULL RETURNING id`, [email]);
console.log(r.rows.length ? `${email} is now an administrator` : `No verified account found for ${email} — sign up and verify the email first`);
await db.end();
