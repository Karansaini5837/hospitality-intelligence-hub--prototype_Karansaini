// Starts the real server on a spare port with a throwaway data directory and exercises
// every API route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-token';
let server;
let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-test-'));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN };
  server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) resolve(); });
    server.on('exit', (code) => reject(new Error('server exited with ' + code)));
  });
});

after(async () => {
  server.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('serves the site but never server code or data', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/assets/site.js')).status, 200);
  assert.equal((await fetch(BASE + '/content/legal.json')).status, 200);
  for (const p of ['/server.mjs', '/package.json', '/data/db.json', '/assets/../server.mjs', '/%2e%2e/server.mjs']) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
  const res = await fetch(BASE + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const again = await fetch(BASE + '/', { headers: { 'If-Modified-Since': res.headers.get('last-modified') } });
  assert.equal(again.status, 304);
});

test('status reports operational components', async () => {
  const s = await (await fetch(BASE + '/api/status')).json();
  assert.equal(s.status, 'operational');
  assert.equal(s.components.length, 3);
  assert.ok(s.uptimeSeconds >= 0);
});

test('legal documents list and load; unknown slug is 404', async () => {
  const list = await (await fetch(BASE + '/api/legal')).json();
  assert.deepEqual(list.documents.map((d) => d.slug), ['privacy', 'terms', 'cookies', 'dpa', 'accessibility']);
  const privacy = await (await fetch(BASE + '/api/legal/privacy')).json();
  assert.equal(privacy.title, 'Privacy Policy');
  assert.match(privacy.notice, /solicitor/);
  assert.ok(privacy.sections.length > 3);
  assert.equal((await fetch(BASE + '/api/legal/nope')).status, 404);
});

test('newsletter validates, subscribes, de-duplicates and unsubscribes', async () => {
  let r = await post('/api/newsletter/subscribe', { email: 'not-an-email', consent: true });
  assert.equal(r.status, 422);
  r = await post('/api/newsletter/subscribe', { email: 'chef@bistro.co.uk', consent: false });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).fields.consent, 'required');

  r = await post('/api/newsletter/subscribe', { email: 'Chef@Bistro.co.uk', consent: true });
  assert.equal(r.status, 200);
  r = await post('/api/newsletter/subscribe', { email: 'chef@bistro.co.uk', consent: true });
  assert.equal((await r.json()).alreadySubscribed, true);

  r = await post('/api/newsletter/unsubscribe', { email: 'chef@bistro.co.uk' });
  assert.equal(r.status, 200);
  const db = JSON.parse(await fs.readFile(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(db.subscribers.length, 1);
  assert.equal(db.subscribers[0].status, 'unsubscribed');
  assert.ok(!JSON.stringify(db).includes('127.0.0.1'), 'raw IPs must not be stored');
});

test('enquiries return field errors, then a reference', async () => {
  let r = await post('/api/enquiries', { type: 'demo', email: 'x' });
  assert.equal(r.status, 422);
  const { fields } = await r.json();
  assert.deepEqual(Object.keys(fields).sort(), ['consent', 'email', 'firstName', 'venue']);

  r = await post('/api/enquiries', { type: 'demo', firstName: 'Asha', email: 'asha@cafe.co.uk', venue: 'Cafe Asha', locations: '2', preferredTime: 'Weekday morning', consent: true });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.match(body.reference, /^HI-\d{8}-[0-9A-F]{6}$/);
  assert.match(body.message, /demo call request/);
});

test('honeypot submissions are accepted silently but not stored', async () => {
  const before = JSON.parse(await fs.readFile(path.join(dataDir, 'db.json'), 'utf8')).enquiries.length;
  const r = await post('/api/enquiries', { firstName: 'Bot', email: 'bot@spam.com', venue: 'x', consent: true, website: 'http://spam' });
  assert.equal(r.status, 200);
  const afterCount = JSON.parse(await fs.readFile(path.join(dataDir, 'db.json'), 'utf8')).enquiries.length;
  assert.equal(afterCount, before);
});

test('privacy requests get a reference and a one-month due date', async () => {
  let r = await post('/api/privacy-requests', { type: 'erasure', fullName: 'Asha', email: 'asha@cafe.co.uk' });
  assert.equal(r.status, 422);
  r = await post('/api/privacy-requests', { type: 'erasure', fullName: 'Asha Patel', email: 'asha@cafe.co.uk', declaration: true });
  const body = await r.json();
  assert.match(body.reference, /^DSR-/);
  const days = (new Date(body.dueBy) - Date.now()) / 86400000;
  assert.ok(days > 27 && days < 32);
  const db = JSON.parse(await fs.readFile(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(db.privacyRequests[0].holdings, { newsletter: 0, enquiries: 1 });
});

test('demo assistant returns scripted answers', async () => {
  let r = await post('/api/ai/chat', { messages: [{ role: 'user', content: 'How much does it cost?' }] });
  let body = await r.json();
  assert.equal(body.source, 'mock');
  assert.match(body.reply, /£79/);
  r = await post('/api/ai/insight', { step: 0, stepName: 'Social Ingestion', scenario: 'TikTok Viral Surge', rows: [{ k: 'Views', v: '48,200', bd: 'High' }] });
  body = await r.json();
  assert.match(body.insight, /48,200/);
  assert.equal((await post('/api/ai/chat', { messages: [] })).status, 422);
});

test('rejects bad requests cleanly', async () => {
  assert.equal((await fetch(BASE + '/api/enquiries', { method: 'POST', body: 'hi' })).status, 415);
  assert.equal((await fetch(BASE + '/api/enquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await post('/api/enquiries', { message: 'x'.repeat(40000) })).status, 413);
  assert.equal((await fetch(BASE + '/api/enquiries')).status, 405);
  assert.equal((await fetch(BASE + '/api/nothing')).status, 404);
});

test('admin endpoints require the token and export CSV', async () => {
  assert.equal((await fetch(BASE + '/api/admin/summary')).status, 401);
  const auth = { headers: { Authorization: 'Bearer ' + ADMIN } };
  const summary = await (await fetch(BASE + '/api/admin/summary', auth)).json();
  assert.equal(summary.enquiries.total, 1);
  const csv = await fetch(BASE + '/api/admin/export/enquiries.csv', auth);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Cafe Asha/);
});

test('rate limiting kicks in', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await post('/api/newsletter/unsubscribe', { email: `r${i}@x.co.uk` });
  assert.equal(last.status, 429);
});
