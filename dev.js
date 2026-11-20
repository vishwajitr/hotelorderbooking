// Local development: same API + UI on http://localhost:4600 with Postgres-in-WASM data in ./.data
// OWNER_PASSWORD=... npm run serve
const path = require('path');
const { createApp } = require('./server');
const { pgliteConn } = require('./local-db');

(async () => {
  if (!process.env.OWNER_PASSWORD) console.warn('OWNER_PASSWORD is not set: nobody can log in. Run: OWNER_PASSWORD=yourpassword npm run serve');
  const app = await createApp(await pgliteConn(process.env.DATA_DIR || path.join(__dirname, '.data')), { serveStatic: true });
  const port = +process.env.PORT || 4600;
  app.listen(port, () => console.log(`Hotel Orders running at http://localhost:${port}`));
})().catch(e => { console.error(e); process.exit(1); });
