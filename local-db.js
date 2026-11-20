// PGlite (real Postgres compiled to WASM) for local dev and tests. Kept out of db.js so the Netlify bundle stays small.
async function pgliteConn(dir) { // dir = folder to persist in; omit for in-memory
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dir);
  await db.waitReady;
  return { query: (s, p) => db.query(s, p), exec: s => db.exec(s), tx: fn => db.transaction(t => fn(t)) };
}

module.exports = { pgliteConn };
