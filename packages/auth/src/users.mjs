// @ts-check
/* DATA_DIR/users.db (SQLite, mode 0600): one row per email and product, made on the first session, last_login updated
   on each one after that. `ref` is what the daily revalidation checks: the license key (purchase) or the code id
   (invite). It never leaves this file; all() leaves it out. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Users {
  /** @param {string} dir DATA_DIR */
  constructor(dir) {
    const file = path.join(path.resolve(dir), 'users.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS users (email TEXT NOT NULL, product TEXT NOT NULL, source TEXT NOT NULL,
      ref TEXT NOT NULL, created TEXT NOT NULL, last_login TEXT NOT NULL, PRIMARY KEY (email, product))`);
  }

  /** a session was opened: a new row, or the same row with this login's source, ref and time */
  login(/** @type {{ email: string, product: string, source: string, ref: string, at: string }} */ u) {
    this.db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email, product)
      DO UPDATE SET source = excluded.source, ref = excluded.ref, last_login = excluded.last_login`).run(u.email, u.product, u.source, u.ref, u.at, u.at);
  }

  /** @returns {any} */
  get(/** @type {string} */ email, /** @type {string} */ product) { return this.db.prepare('SELECT * FROM users WHERE email = ? AND product = ?').get(email, product); }

  /** emails that came in through this code (a seat each), other than `email` */
  seats(/** @type {string} */ codeId, /** @type {string} */ email = '') { return Number(/** @type {any} */ (this.db.prepare("SELECT count(*) AS n FROM users WHERE ref = ? AND source LIKE 'invite:%' AND email != ?").get(codeId, email)).n); }

  all() { return this.db.prepare('SELECT email, product, source, created, last_login FROM users ORDER BY created').all(); }
  close() { this.db.close(); }
}
