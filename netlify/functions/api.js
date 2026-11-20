// Netlify Function: the whole /api runs here, on Netlify DB (Postgres). NETLIFY_DATABASE_URL is set by Netlify DB.
const serverless = require('serverless-http');
const { createApp } = require('../../server');
const { pgConn } = require('../../db');

let ready; // reused while the function stays warm
exports.handler = async (event, context) => {
  ready ??= createApp(pgConn(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL))
    .then(app => serverless(app))
    .catch(e => { ready = null; throw e; });
  return (await ready)(event, context);
};
