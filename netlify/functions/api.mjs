// Netlify Function (modern format, so Netlify Database's address is available): the whole /api runs here.
// A small bridge turns the web Request into the event shape serverless-http expects, so the Express routes stay as-is.
import serverless from 'serverless-http';
// Named here so Netlify's packager ships them; server.js and db.js require() them at run time.
import 'express';
import 'pg';
import server from '../../server.js';
import db from '../../db.js';

let ready; // reused while the function stays warm

export default async req => {
  // Netlify hands site variables to modern functions on Netlify.env; server.js reads process.env
  for (const k of ['OWNER_PASSWORD', 'SESSION_SECRET', 'HOTEL_TZ']) if (!process.env[k] && Netlify.env.has(k)) process.env[k] = Netlify.env.get(k);
  ready ??=server.createApp(db.pgConn(Netlify.env.get('NETLIFY_DB_URL') || Netlify.env.get('DATABASE_URL')))
    .then(app => serverless(app))
    .catch(e => { ready = null; throw e; });
  try {
    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams);
    const res = await (await ready)({
      httpMethod: req.method,
      path: url.pathname,
      headers: Object.fromEntries(req.headers),
      queryStringParameters: Object.keys(query).length ? query : null,
      body: ['GET', 'HEAD'].includes(req.method) ? null : await req.text(),
      isBase64Encoded: false,
    }, {});
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers || {})) headers.set(k, String(v));
    for (const [k, vs] of Object.entries(res.multiValueHeaders || {})) for (const v of vs) headers.append(k, String(v));
    return new Response(res.isBase64Encoded ? Buffer.from(res.body, 'base64') : res.body, { status: res.statusCode, headers });
  } catch (e) { // e.g. database unreachable: log the detail, show the user something plain
    console.error(e);
    return Response.json({ error: 'Database unavailable. Try again in a minute.' }, { status: 503 });
  }
};

export const config = { path: '/api/*' };
