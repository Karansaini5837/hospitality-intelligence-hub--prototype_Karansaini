// Hospitality Intelligence Hub — prototype backend
// Zero required dependencies (Node 18+). Serves the static site and a small JSON API
// that powers the footer (newsletter, legal documents, data-rights requests, live
// status), the contact/pilot form, and the scripted demo assistant.
//
//   node server.mjs                 → http://localhost:3000
//   PORT=8080 node server.mjs
//
// Optional environment variables:
//   ADMIN_TOKEN         enables the read-only admin endpoints (/api/admin/*)
//   DATA_DIR            where submissions are stored (default ./data)

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const STARTED_AT = new Date();
const MAX_BODY = 32 * 1024;

// ── STORAGE ──────────────────────────────────────────────────
// A single JSON file, written atomically (temp file + rename) through a queue so
// concurrent requests never interleave writes.
const COLLECTIONS = ['subscribers', 'enquiries', 'privacyRequests'];
let db = null;
let writeChain = Promise.resolve();

async function loadDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${DB_FILE}: ${err.message}`);
    db = {};
  }
  for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
}

function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, DB_FILE);
  });
  return writeChain;
}

// ── LEGAL CONTENT ────────────────────────────────────────────
const LEGAL_FILE = path.join(ROOT, 'content', 'legal.json');
async function loadLegal() {
  return JSON.parse(await fs.readFile(LEGAL_FILE, 'utf8'));
}

// ── HELPERS ──────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const normEmail = (e) => String(e || '').trim().toLowerCase();

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function reference(prefix) {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update('hi-salt:' + ip).digest('hex').slice(0, 16);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Malformed JSON body.');
  }
}

// Honeypot: real visitors never see the "website" field; bots tend to fill it.
function isBot(body) {
  return typeof body.website === 'string' && body.website.trim() !== '';
}

// ── RATE LIMITING (fixed window per IP + bucket) ─────────────
const hits = new Map();
function rateLimit(req, bucket, limit, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > windowMs) {
    hits.set(key, { start: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retry = Math.ceil((entry.start + windowMs - now) / 1000);
    throw new HttpError(429, `Too many requests — please try again in ${retry}s.`);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now - v.start > 60 * 60 * 1000) hits.delete(k);
}, 10 * 60 * 1000).unref();

// ── RESPONSES ────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

// ── DEMO ASSISTANT ───────────────────────────────────────────
// A scripted mock: the chat bubble and the Live Demo "AI insight" answer from this
// knowledge base and template. No external AI service is called.
const KB = [
  { keys: ['attribution', 'gap'], answer: 'The attribution gap is the inability of restaurant operators to link a specific social post or creator to seated covers and spend. Hospitality Intelligence connects social activity, bookings, POS spend and reviews so operators can see which campaigns actually bring in paying, returning guests.' },
  { keys: ['track', 'how does it work', 'how it works', 'measure', 'promo code', 'utm'], answer: 'Attribution starts with first-party signals the venue controls — creator-specific booking links, UTM-tagged links, promo codes, QR codes and a "how did you hear about us?" field — which are matched to reservation and POS records. Where no direct link exists, the platform estimates campaign lift from booking and spend patterns over time.' },
  { keys: ['price', 'pricing', 'cost', 'how much', 'plan', '£', 'subscription'], answer: 'Indicative pricing: Starter £79/month, Professional £199/month (predictive alerts and POS integration) and Enterprise £499/month for multi-site groups. A one-off integration setup fee of £600 applies. Pilot venues get the Professional tier free for 8 weeks.' },
  { keys: ['pilot', 'trial', 'free'], answer: 'The free 8-week pilot gives a venue Professional-tier access, help connecting POS and booking systems, weekly attribution reports and an end-of-pilot ROI review. No card is needed. Pilots are being recruited now in London — use the Contact page to apply.' },
  { keys: ['result', 'proof', 'evidence', 'lift', 'roi'], answer: 'The platform is at prototype stage and the London pilots are still being recruited, so there are no verified customer results yet. The pilot will measure attributed social revenue, no-show rate and how often operators act on alerts, and results will be published once they are independently checked.' },
  { keys: ['gdpr', 'privacy', 'data', 'ico', 'personal'], answer: 'The platform is designed for UK GDPR: venues act as data controllers and Hospitality Intelligence as their processor under a Data Processing Agreement. Guest data is minimised and pseudonymised before analysis, and regional benchmarks only use aggregated figures. You can read the Privacy Policy or submit a data-rights request from the footer.' },
  { keys: ['cocp', 'alert', 'surge', 'capacity', 'staff'], answer: 'The Campaign-to-Operations Causality Protocol (COCP) watches for campaigns that are driving bookings above a venue\'s normal capacity and warns the manager ahead of service, so they can adjust staffing, booking slots or prep.' },
  { keys: ['cin', 'benchmark', 'network'], answer: 'The Community Intelligence Network (CIN) will provide anonymised, aggregated regional benchmarks — for example typical booking lift from creator campaigns by cuisine and city — without sharing any individual venue\'s data.' },
  { keys: ['founder', 'team', 'kiranjeet', 'cto', 'who'], answer: 'Hospitality Intelligence is founded by Kiranjeet Kaur (MSc Management, BPP University London), who worked in front-of-house and supervisory roles in London hospitality. Technical development is led by CTO Aashutosh Rana (B.Tech Computer Science), whose background is in software testing, API and system validation.' },
  { keys: ['integrat', 'pos', 'opentable', 'square', 'zonal', 'lightspeed', 'resdiary', 'sevenrooms'], answer: 'Planned integrations include POS systems used by UK independents (Square, Lightspeed, Epos Now, Zonal), booking platforms (OpenTable, ResDiary, SevenRooms), Instagram and TikTok business accounts, Google Business Profile and Xero. Integrations are being built in that order of pilot demand.' },
  { keys: ['esg', 'sustainab', 'waste', 'carbon'], answer: 'The sustainability benefit is indirect: better demand forecasting helps venues staff and prep to expected covers, which can reduce wasted labour and food. The platform reports these operational efficiencies rather than claiming certified environmental outcomes.' },
  { keys: ['contact', 'email', 'phone', 'call', 'demo'], answer: 'You can reach the team at hospitalityintelligencehub@outlook.com or +44 7438 753798 (Mon–Fri, 9am–6pm). The Contact page lets you book a demo call or apply for the pilot.' },
];

function kbAnswer(question) {
  const q = String(question || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of KB) {
    const score = item.keys.reduce((s, k) => s + (q.includes(k) ? 1 : 0), 0);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best ? best.answer : 'I can help with how attribution works, pricing, the free 8-week pilot, integrations, data protection, or how to contact the team. What would you like to know?';
}

function mockInsight(stepName, scenario, rows) {
  const first = rows[0];
  const figure = first ? `${first.k} is ${first.v}` : 'the signals at this step are within normal range';
  return `At the ${stepName} step of the ${scenario} scenario, ${figure}. The key commercial question is whether this demand converts into high-value, returning guests rather than one-off visits. Review the flagged items before the next service and adjust staffing or booking slots if demand exceeds normal capacity.`;
}

// ── ROUTES ───────────────────────────────────────────────────
const routes = {
  'GET /api/health': async () => ({ ok: true }),

  'GET /api/status': async () => {
    let storage = 'operational';
    try { await fs.access(DATA_DIR, fs.constants.W_OK); } catch { storage = 'degraded'; }
    return {
      status: storage,
      version: VERSION,
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      components: [
        { name: 'Website & API', status: 'operational' },
        { name: 'Submission storage', status: storage },
        { name: 'Demo assistant', status: 'operational', detail: 'Scripted responses' },
      ],
    };
  },

  // Newsletter ------------------------------------------------
  'POST /api/newsletter/subscribe': async (req, body) => {
    rateLimit(req, 'newsletter', 8, 10 * 60 * 1000);
    if (isBot(body)) return { ok: true, message: 'Thanks for subscribing!' };
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(422, 'Please enter a valid email address.', { email: 'invalid' });
    if (body.consent !== true) throw new HttpError(422, 'Please confirm you agree to receive the newsletter.', { consent: 'required' });

    const existing = db.subscribers.find((s) => s.email === email);
    if (existing && existing.status === 'subscribed') {
      return { ok: true, alreadySubscribed: true, message: 'You\'re already subscribed — thanks!' };
    }
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { status: 'subscribed', subscribedAt: now, unsubscribedAt: null });
    } else {
      db.subscribers.push({
        id: crypto.randomUUID(),
        email,
        status: 'subscribed',
        source: clean(body.source, 40) || 'footer',
        consentText: 'Agreed to receive the Hospitality Intelligence newsletter; can unsubscribe at any time.',
        subscribedAt: now,
        unsubscribedAt: null,
        ipHash: hashIp(clientIp(req)),
      });
    }
    await persist();
    return { ok: true, message: 'Subscribed! Look out for our monthly UK hospitality insights.' };
  },

  'POST /api/newsletter/unsubscribe': async (req, body) => {
    rateLimit(req, 'newsletter', 8, 10 * 60 * 1000);
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(422, 'Please enter a valid email address.', { email: 'invalid' });
    const sub = db.subscribers.find((s) => s.email === email && s.status === 'subscribed');
    if (sub) {
      sub.status = 'unsubscribed';
      sub.unsubscribedAt = new Date().toISOString();
      await persist();
    }
    // Same response either way so the endpoint can't be used to check who is subscribed.
    return { ok: true, message: 'If that address was subscribed, it has been removed. You won\'t receive further emails.' };
  },

  // Contact / pilot / demo enquiries --------------------------
  'POST /api/enquiries': async (req, body) => {
    rateLimit(req, 'enquiry', 5, 10 * 60 * 1000);
    const ref = reference('HI');
    if (isBot(body)) return { ok: true, reference: ref };
    const types = ['pilot', 'demo', 'general'];
    const e = {
      type: types.includes(body.type) ? body.type : 'general',
      firstName: clean(body.firstName, 60),
      lastName: clean(body.lastName, 60),
      email: normEmail(body.email),
      venue: clean(body.venue, 120),
      locations: clean(body.locations, 6),
      challenge: clean(body.challenge, 80),
      preferredTime: clean(body.preferredTime, 40),
      message: clean(body.message, 2000),
    };
    const fields = {};
    if (!e.firstName) fields.firstName = 'required';
    if (!EMAIL_RE.test(e.email)) fields.email = 'invalid';
    if (!e.venue) fields.venue = 'required';
    if (e.locations && !/^\d{1,4}$/.test(e.locations)) fields.locations = 'invalid';
    if (body.consent !== true) fields.consent = 'required';
    if (Object.keys(fields).length) throw new HttpError(422, 'Please check the highlighted fields.', fields);

    db.enquiries.push({ id: crypto.randomUUID(), reference: ref, ...e, status: 'new', createdAt: new Date().toISOString(), ipHash: hashIp(clientIp(req)) });
    await persist();
    const what = e.type === 'demo' ? 'demo call request' : e.type === 'pilot' ? 'pilot application' : 'message';
    return { ok: true, reference: ref, message: `Thanks ${e.firstName} — your ${what} has been received. We reply within one working day.` };
  },

  // UK GDPR data-subject requests -----------------------------
  'POST /api/privacy-requests': async (req, body) => {
    rateLimit(req, 'privacy', 5, 60 * 60 * 1000);
    const types = {
      access: 'Access a copy of my data',
      erasure: 'Delete my data',
      rectification: 'Correct my data',
      restriction: 'Restrict processing',
      objection: 'Object to processing',
      portability: 'Data portability',
    };
    const r = {
      type: clean(body.type, 20),
      fullName: clean(body.fullName, 120),
      email: normEmail(body.email),
      relationship: clean(body.relationship, 40),
      details: clean(body.details, 2000),
    };
    const fields = {};
    if (!types[r.type]) fields.type = 'required';
    if (!r.fullName) fields.fullName = 'required';
    if (!EMAIL_RE.test(r.email)) fields.email = 'invalid';
    if (body.declaration !== true) fields.declaration = 'required';
    if (Object.keys(fields).length) throw new HttpError(422, 'Please check the highlighted fields.', fields);

    const received = new Date();
    // UK GDPR Art. 12(3): respond within one month of receipt.
    const due = new Date(received);
    due.setMonth(due.getMonth() + 1);
    const ref = reference('DSR');
    // Count what we hold for this email so the team can action the request quickly.
    const holdings = {
      newsletter: db.subscribers.filter((s) => s.email === r.email).length,
      enquiries: db.enquiries.filter((x) => x.email === r.email).length,
    };
    db.privacyRequests.push({ id: crypto.randomUUID(), reference: ref, ...r, typeLabel: types[r.type], status: 'awaiting-verification', holdings, receivedAt: received.toISOString(), dueBy: due.toISOString() });
    await persist();
    return {
      ok: true,
      reference: ref,
      dueBy: due.toISOString(),
      message: `We'll verify your identity by email and respond by ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
    };
  },

  // Legal documents -------------------------------------------
  'GET /api/legal': async () => {
    const legal = await loadLegal();
    return { documents: Object.entries(legal.documents).map(([slug, d]) => ({ slug, title: d.title, summary: d.summary, updated: legal.updated })) };
  },

  // Demo assistant (scripted) ---------------------------------
  'POST /api/ai/chat': async (req, body) => {
    rateLimit(req, 'ai', 30, 10 * 60 * 1000);
    const history = Array.isArray(body.messages) ? body.messages : [];
    const last = [...history].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    if (!last) throw new HttpError(422, 'Ask a question first.');
    return { reply: kbAnswer(clean(last.content, 1000)), source: 'mock' };
  },

  'POST /api/ai/insight': async (req, body) => {
    rateLimit(req, 'ai', 30, 10 * 60 * 1000);
    const stepName = clean(body.stepName, 80) || 'Pipeline step';
    const scenario = clean(body.scenario, 80) || 'Scenario';
    const rows = (Array.isArray(body.rows) ? body.rows.slice(0, 12) : []).map((r) => ({ k: clean(r?.k, 80), v: clean(r?.v, 80) }));
    return { insight: mockInsight(stepName, scenario, rows), source: 'mock' };
  },

  // Admin (read-only) -----------------------------------------
  'GET /api/admin/summary': async (req) => {
    requireAdmin(req);
    const count = (arr, pred) => arr.filter(pred).length;
    return {
      subscribers: { active: count(db.subscribers, (s) => s.status === 'subscribed'), total: db.subscribers.length },
      enquiries: { new: count(db.enquiries, (e) => e.status === 'new'), total: db.enquiries.length },
      privacyRequests: { open: count(db.privacyRequests, (r) => r.status !== 'closed'), total: db.privacyRequests.length },
    };
  },
};

function requireAdmin(req) {
  if (!ADMIN_TOKEN) throw new HttpError(403, 'Admin endpoints are disabled. Set ADMIN_TOKEN to enable them.');
  const auth = req.headers.authorization || '';
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(ADMIN_TOKEN);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid admin token.');
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

async function handleApi(req, res, url) {
  const key = `${req.method} ${url.pathname}`;

  // Dynamic routes
  const legalMatch = url.pathname.match(/^\/api\/legal\/([a-z-]+)$/);
  if (req.method === 'GET' && legalMatch) {
    const legal = await loadLegal();
    const doc = legal.documents[legalMatch[1]];
    if (!doc) throw new HttpError(404, 'Document not found.');
    return send(res, 200, { slug: legalMatch[1], updated: legal.updated, company: legal.company, notice: legal.notice, ...doc });
  }
  const exportMatch = url.pathname.match(/^\/api\/admin\/export\/([a-zA-Z]+)\.(csv|json)$/);
  if (req.method === 'GET' && exportMatch) {
    requireAdmin(req);
    const [, collection, format] = exportMatch;
    if (!COLLECTIONS.includes(collection)) throw new HttpError(404, 'Unknown collection.');
    const rows = db[collection];
    return format === 'csv'
      ? send(res, 200, toCsv(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${collection}.csv"` })
      : send(res, 200, rows);
  }

  const handler = routes[key];
  if (!handler) {
    const allowed = Object.keys(routes).filter((k) => k.endsWith(' ' + url.pathname)).map((k) => k.split(' ')[0]);
    if (!allowed.length) throw new HttpError(404, 'Not found.');
    res.setHeader('Allow', allowed.join(', '));
    throw new HttpError(405, 'Method not allowed.');
  }
  const body = req.method === 'POST' ? await readJson(req) : undefined;
  send(res, 200, await handler(req, body));
}

// ── STATIC FILES ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
// Only these paths are ever served — never server code, data/ or node_modules/.
const PUBLIC = [/^\/index\.html$/, /^\/assets\/[\w.-]+$/, /^\/content\/[\w.-]+\.json$/, /^\/robots\.txt$/];

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (!PUBLIC.some((re) => re.test(pathname))) return send(res, 404, 'Not found');
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT + path.sep) || !existsSync(file)) return send(res, 404, 'Not found');
  // Browsers revalidate every time (cheap 304s), so visitors never get stale assets after an update.
  const { mtime } = await fs.stat(file);
  const lastModified = new Date(Math.floor(mtime.getTime() / 1000) * 1000);
  const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache', 'Last-Modified': lastModified.toUTCString() };
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (!Number.isNaN(since) && lastModified.getTime() <= since) {
    res.writeHead(304, headers);
    return res.end();
  }
  const data = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ── SERVER ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { ok: false, error: err.message, fields: err.fields });
    } else {
      console.error(err);
      send(res, 500, { ok: false, error: 'Something went wrong on our side. Please try again.' });
    }
  }
});

await loadDb();
await loadLegal(); // fail fast if the legal content is missing or invalid
server.listen(PORT, () => {
  console.log(`Hospitality Intelligence Hub v${VERSION} → http://localhost:${PORT}`);
  console.log(`  storage: ${DB_FILE}`);
  console.log('  assistant: scripted demo responses');
  console.log(`  admin:   ${ADMIN_TOKEN ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`);
});
