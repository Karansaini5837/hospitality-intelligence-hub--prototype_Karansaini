// Shared site behaviour: API client, hash routing, the footer rendered on every page,
// legal / data-rights / subscription / status dialogs, and the contact form.
(function () {
  'use strict';

  const COMPANY_EMAIL = 'hospitalityintelligencehub@outlook.com';
  const API_TIMEOUT_MS = 15000;

  // ── API CLIENT ──────────────────────────────────────────────
  // Throws ApiError for HTTP errors (with the server's message and field errors) and
  // OfflineError when the backend can't be reached (e.g. the page is opened as a file
  // or hosted somewhere static).
  class ApiError extends Error {
    constructor(status, message, fields) { super(message); this.status = status; this.fields = fields || {}; }
  }
  class OfflineError extends Error {}

  const canReachApi = location.protocol === 'http:' || location.protocol === 'https:';

  async function api(path, { method = 'GET', body } = {}) {
    if (!canReachApi) throw new OfflineError('Backend unavailable');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      throw new OfflineError('Backend unavailable');
    } finally {
      clearTimeout(timer);
    }
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : {};
    // A static host answers /api/* with its own 404 page rather than JSON.
    if (!isJson) throw new OfflineError('Backend unavailable');
    if (!res.ok) throw new ApiError(res.status, data.error || 'Request failed.', data.fields);
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg) => { if (typeof window.showToast === 'function') window.showToast(msg); };
  const offlineHtml = () => `Our server can't be reached right now. Please email us at <a href="mailto:${COMPANY_EMAIL}">${COMPANY_EMAIL}</a> instead.`;

  function errorMessage(err) {
    if (err instanceof OfflineError) return offlineHtml();
    if (err instanceof ApiError) return esc(err.message);
    return 'Something went wrong. Please try again.';
  }

  // Marks invalid fields inside a form from the server's {field: reason} map.
  function showFieldErrors(form, fields) {
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelectorAll('.fg-ck.invalid').forEach((el) => el.classList.remove('invalid'));
    form.querySelectorAll('.fg-err').forEach((el) => { el.textContent = ''; });
    let first = null;
    for (const [name, reason] of Object.entries(fields || {})) {
      const el = form.elements[name];
      if (!el) continue;
      const input = el.length && !el.tagName ? el[0] : el;
      input.setAttribute('aria-invalid', 'true');
      const ck = input.closest('.fg-ck');
      if (ck) ck.classList.add('invalid');
      const errEl = form.querySelector(`[data-err-for="${name}"]`);
      if (errEl) errEl.textContent = reason === 'invalid' ? 'Please check this value.' : 'This field is required.';
      first = first || input;
    }
    if (first) first.focus();
  }

  // ── ROUTING ─────────────────────────────────────────────────
  // Pages are addressed as #/pricing; dialogs as #/legal/privacy, #/data-rights,
  // #/subscription and #/status. Links are ordinary hrefs, so they can be opened in a
  // new tab, bookmarked and shared, and the browser Back button works.
  const showPage = window.nav;
  const pageIds = () => Object.keys(typeof pageMap !== 'undefined' ? pageMap : {}); // eslint-disable-line no-undef
  const currentPage = () => (typeof curPage !== 'undefined' ? curPage : 'home'); // eslint-disable-line no-undef

  window.nav = function (id) {
    const target = '#/' + id;
    if (location.hash === target) showPage(id);
    else location.hash = target;
  };

  function route() {
    const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const [first, second] = hash.split('/');
    const dialogs = { legal: () => openLegal(second), 'data-rights': openDataRights, subscription: openSubscription, status: openStatus };
    if (dialogs[first]) { dialogs[first](); return; }
    closeDialog({ restoreHash: false });
    const id = pageIds().includes(first) ? first : 'home';
    if (id !== currentPage()) showPage(id);
    if (typeof window.setTab === 'function') window.setTab(id);
    updateShareLinks();
  }
  window.addEventListener('hashchange', route);

  // ── DIALOG ──────────────────────────────────────────────────
  let overlay = null;
  let lastFocus = null;
  let dialogSeq = 0; // bumps whenever the dialog's content changes, so slow loads can't overwrite newer content

  function openDialog({ title, subtitle = '', bodyHtml, label }) {
    if (!overlay) {
      lastFocus = document.activeElement;
      overlay = document.createElement('div');
      overlay.className = 'hi-ov';
      overlay.innerHTML = `<div class="hi-dlg" role="dialog" aria-modal="true" aria-labelledby="hiDlgTitle" tabindex="-1">
        <div class="hi-dlg-hd"><div><h2 id="hiDlgTitle"></h2><div class="hi-dlg-sub"></div></div>
        <button type="button" class="hi-x" aria-label="Close dialog">&#x2715;</button></div>
        <div class="hi-dlg-bd"></div></div>`;
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });
      overlay.querySelector('.hi-x').addEventListener('click', () => closeDialog());
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => overlay.classList.add('op'));
    }
    dialogSeq += 1;
    overlay.dataset.label = label || '';
    overlay.querySelector('#hiDlgTitle').textContent = title;
    overlay.querySelector('.hi-dlg-sub').textContent = subtitle;
    overlay.querySelector('.hi-dlg-bd').innerHTML = bodyHtml;
    overlay.querySelector('.hi-dlg-bd').scrollTop = 0;
    const firstField = overlay.querySelector('.hi-dlg-bd input, .hi-dlg-bd select, .hi-dlg-bd textarea');
    (firstField || overlay.querySelector('.hi-dlg')).focus();
    return overlay.querySelector('.hi-dlg-bd');
  }

  function closeDialog({ restoreHash = true } = {}) {
    if (!overlay) return;
    const el = overlay;
    overlay = null;
    el.classList.remove('op');
    setTimeout(() => el.remove(), 180);
    document.body.style.overflow = '';
    if (restoreHash) {
      // Replace the dialog URL so Back doesn't reopen it.
      history.replaceState(null, '', '#/' + currentPage());
    }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // Listens on the document so Escape still works after a form inside the dialog is
  // replaced and focus falls back to <body>.
  document.addEventListener('keydown', (e) => { if (overlay) trapKeys(e); });

  function trapKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('a[href],button:not([disabled]),input:not([type=hidden]):not([tabindex="-1"]),select,textarea')]
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const loadingHtml = '<div class="hi-loading"><span class="ld"></span>Loading&hellip;</div>';

  // ── LEGAL DOCUMENTS ─────────────────────────────────────────
  // Served by the backend (/api/legal/:slug); falls back to the same JSON file when the
  // site is hosted statically.
  let legalCache = null;
  async function fetchLegal(slug) {
    try {
      return await api('/api/legal/' + encodeURIComponent(slug));
    } catch (err) {
      if (!(err instanceof OfflineError)) throw err;
      if (!legalCache) {
        const res = await fetch('content/legal.json');
        if (!res.ok) throw new OfflineError('Legal content unavailable');
        legalCache = await res.json();
      }
      const doc = legalCache.documents[slug];
      if (!doc) throw new ApiError(404, 'Document not found.');
      return { slug, updated: legalCache.updated, company: legalCache.company, notice: legalCache.notice, ...doc };
    }
  }

  async function openLegal(slug) {
    openDialog({ title: 'Loading…', bodyHtml: loadingHtml, label: 'legal' });
    const seq = dialogSeq;
    try {
      const doc = await fetchLegal(slug || 'privacy');
      if (!overlay || seq !== dialogSeq) return; // closed or replaced meanwhile
      const updated = new Date(doc.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const sections = doc.sections.map((s) => `<h3>${esc(s.heading)}</h3>`
        + (s.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')
        + (s.list ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : '')).join('');
      const actions = slug === 'privacy'
        ? '<a class="hi-btn pri" href="#/data-rights">Make a data-rights request</a>'
        : '';
      openDialog({
        title: doc.title,
        subtitle: `Last updated ${updated} · ${doc.company ? doc.company.name : ''}`,
        label: 'legal',
        bodyHtml: (doc.notice ? `<div class="hi-note">${esc(doc.notice)}</div>` : '') + sections
          + `<div class="hi-dlg-ft">${actions}<button type="button" class="hi-btn" data-print>Print / save as PDF</button>
             <a class="hi-btn" href="mailto:${COMPANY_EMAIL}?subject=${encodeURIComponent(doc.title + ' question')}">Email a question</a></div>`,
      });
      overlay.querySelector('[data-print]').addEventListener('click', () => printDoc(doc));
    } catch (err) {
      if (!overlay || seq !== dialogSeq) return;
      openDialog({ title: 'Document unavailable', bodyHtml: `<div class="form-status err">${errorMessage(err)}</div>`, label: 'legal' });
    }
  }

  function printDoc(doc) {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print this document'); return; }
    const html = doc.sections.map((s) => `<h2>${esc(s.heading)}</h2>`
      + (s.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')
      + (s.list ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : '')).join('');
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
      <style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a0840}h1{font-size:24px}h2{font-size:17px;margin-top:24px}small{color:#666}</style></head>
      <body><h1>${esc(doc.title)}</h1><small>${esc(doc.company ? doc.company.name : '')} · Last updated ${esc(doc.updated)}</small>${html}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  // ── DATA-RIGHTS REQUEST (UK GDPR) ───────────────────────────
  function openDataRights() {
    const body = openDialog({
      title: 'Your data rights',
      subtitle: 'UK GDPR request · we respond within one month',
      label: 'data-rights',
      bodyHtml: `<p style="margin-bottom:14px">Use this form to access, correct or delete the personal data we hold about you. We'll email you to confirm your identity before acting on the request.</p>
      <form novalidate data-form="data-rights">
        <div class="fg-grp"><label class="fg-lb" for="dsrType">What would you like us to do?</label>
          <select class="fg-ctrl" id="dsrType" name="type" required>
            <option value="">Choose a request type…</option>
            <option value="access">Give me a copy of my data</option>
            <option value="erasure">Delete my data</option>
            <option value="rectification">Correct my data</option>
            <option value="restriction">Restrict how my data is used</option>
            <option value="objection">Object to how my data is used</option>
            <option value="portability">Send my data to another organisation</option>
          </select><span class="fg-err" data-err-for="type"></span></div>
        <div class="fg-rw fg-grp">
          <div><label class="fg-lb" for="dsrName">Full name</label><input class="fg-ctrl" id="dsrName" name="fullName" autocomplete="name" required/><span class="fg-err" data-err-for="fullName"></span></div>
          <div><label class="fg-lb" for="dsrEmail">Email address</label><input class="fg-ctrl" id="dsrEmail" name="email" type="email" autocomplete="email" required/><span class="fg-err" data-err-for="email"></span></div>
        </div>
        <div class="fg-grp"><label class="fg-lb" for="dsrRel">How do you know us?</label>
          <select class="fg-ctrl" id="dsrRel" name="relationship">
            <option>Website visitor</option><option>Newsletter subscriber</option><option>Pilot or customer contact</option><option>Guest of a venue using the platform</option><option>Other</option>
          </select></div>
        <div class="fg-grp"><label class="fg-lb" for="dsrDetails">Details (optional)</label><textarea class="fg-ctrl" id="dsrDetails" name="details" maxlength="2000" placeholder="Anything that helps us find your data, e.g. the venue name or dates"></textarea></div>
        <div class="fg-grp"><label class="fg-ck"><input type="checkbox" name="declaration"/><span>I confirm I am the person named above, or I am authorised to act for them.</span></label></div>
        <input class="hi-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"/>
        <button class="fg-sub" type="submit">Submit request</button>
        <div class="form-status" role="status" aria-live="polite"></div>
      </form>`,
    });
    body.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const f = form.elements;
      const status = form.querySelector('.form-status');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Submitting…';
      status.className = 'form-status';
      try {
        const r = await api('/api/privacy-requests', { method: 'POST', body: {
          type: f.type.value, fullName: f.fullName.value, email: f.email.value, relationship: f.relationship.value,
          details: f.details.value, declaration: f.declaration.checked, website: f.website.value,
        } });
        form.innerHTML = `<div class="form-status ok">Request received. Your reference is <code>${esc(r.reference)}</code>.<br>${esc(r.message)}</div>
          <div class="hi-dlg-ft"><button type="button" class="hi-btn pri" data-close>Done</button></div>`;
        const done = form.querySelector('[data-close]');
        done.addEventListener('click', () => closeDialog());
        done.focus();
        toast('Data-rights request ' + r.reference + ' received');
      } catch (err) {
        if (err instanceof ApiError) showFieldErrors(form, err.fields);
        status.className = 'form-status err';
        status.innerHTML = errorMessage(err);
        btn.disabled = false; btn.textContent = 'Submit request';
      }
    });
  }

  // ── NEWSLETTER: SUBSCRIBE / UNSUBSCRIBE ─────────────────────
  async function submitNewsletter(form) {
    const email = form.elements.email;
    const consent = form.elements.consent;
    const msg = form.querySelector('.ft-msg');
    const btn = form.querySelector('button');
    email.removeAttribute('aria-invalid');
    if (!email.value.trim() || !email.checkValidity()) {
      email.setAttribute('aria-invalid', 'true'); msg.className = 'ft-msg err'; msg.textContent = 'Please enter a valid email address.'; email.focus(); return;
    }
    if (!consent.checked) {
      msg.className = 'ft-msg err'; msg.textContent = 'Please tick the box to agree to receive emails.'; consent.focus(); return;
    }
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('/api/newsletter/subscribe', { method: 'POST', body: { email: email.value, consent: true, source: 'footer:' + currentPage(), website: form.elements.website.value } });
      msg.className = 'ft-msg ok'; msg.textContent = r.message;
      form.reset();
      toast(r.alreadySubscribed ? 'Already subscribed' : 'Subscribed to Hospitality Intelligence insights');
    } catch (err) {
      if (err instanceof ApiError && err.fields.email) email.setAttribute('aria-invalid', 'true');
      msg.className = 'ft-msg err'; msg.innerHTML = errorMessage(err);
    } finally {
      btn.disabled = false; btn.textContent = 'Subscribe';
    }
  }

  function openSubscription() {
    const body = openDialog({
      title: 'Manage your subscription',
      subtitle: 'Newsletter preferences',
      label: 'subscription',
      bodyHtml: `<p style="margin-bottom:14px">Enter the email address you subscribed with and we'll stop sending you the newsletter.</p>
      <form novalidate data-form="unsubscribe">
        <div class="fg-grp"><label class="fg-lb" for="unsubEmail">Email address</label><input class="fg-ctrl" id="unsubEmail" name="email" type="email" autocomplete="email" required/><span class="fg-err" data-err-for="email"></span></div>
        <button class="fg-sub" type="submit">Unsubscribe</button>
        <div class="form-status" role="status" aria-live="polite"></div>
      </form>`,
    });
    body.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const status = form.querySelector('.form-status');
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const r = await api('/api/newsletter/unsubscribe', { method: 'POST', body: { email: form.elements.email.value } });
        status.className = 'form-status ok'; status.textContent = r.message;
        form.elements.email.value = '';
        showFieldErrors(form, {});
      } catch (err) {
        if (err instanceof ApiError) showFieldErrors(form, err.fields);
        status.className = 'form-status err'; status.innerHTML = errorMessage(err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── LIVE STATUS ─────────────────────────────────────────────
  let lastStatus = null;

  function formatUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }

  async function refreshStatus() {
    try {
      const t0 = performance.now();
      lastStatus = await api('/api/status');
      lastStatus.roundTripMs = Math.round(performance.now() - t0);
    } catch (err) {
      lastStatus = { status: err instanceof OfflineError ? 'offline' : 'down' };
    }
    const label = { operational: 'All systems operational', degraded: 'Partial outage', offline: 'Static preview · backend offline' }[lastStatus.status] || 'Service disruption';
    const dot = { operational: '', degraded: 'off', offline: 'off' }[lastStatus.status] ?? 'down';
    document.querySelectorAll('[data-status-badge]').forEach((b) => {
      b.querySelector('.ld').className = 'ld ' + dot;
      b.querySelector('[data-status-text]').textContent = label.toUpperCase();
    });
    return lastStatus;
  }

  async function openStatus() {
    openDialog({ title: 'Platform status', bodyHtml: loadingHtml, label: 'status' });
    const seq = dialogSeq;
    const s = await refreshStatus();
    if (!overlay || seq !== dialogSeq) return;
    let html;
    if (s.status === 'offline' || s.status === 'down') {
      html = `<div class="hi-status-hero ${s.status === 'down' ? 'down' : 'warn'}"><span class="ld ${s.status === 'down' ? 'down' : 'off'}"></span>${s.status === 'down' ? 'The API is returning errors' : 'Backend not connected'}</div>
        <p>${s.status === 'offline' ? 'You are viewing a static copy of the site. Forms, the newsletter and live AI need the Node.js backend — run <code>npm start</code> and open <code>http://localhost:3000</code>.' : 'Please try again in a few minutes.'}</p>`;
    } else {
      const hero = s.status === 'operational' ? 'ok' : 'warn';
      html = `<div class="hi-status-hero ${hero}"><span class="ld ${hero === 'ok' ? '' : 'off'}"></span>${hero === 'ok' ? 'All systems operational' : 'Some systems are degraded'}</div>`
        + s.components.map((c) => `<div class="hi-comp"><span>${esc(c.name)}</span><span class="${c.status === 'operational' ? '' : 'warn'}">${esc(c.status)}${c.detail ? ' · ' + esc(c.detail) : ''}</span></div>`).join('')
        + `<div class="hi-meta"><div><b>Uptime</b><span>${formatUptime(s.uptimeSeconds)}</span></div><div><b>Response time</b><span>${s.roundTripMs} ms</span></div><div><b>Version</b><span>v${esc(s.version)}</span></div><div><b>Checked</b><span>${new Date(s.checkedAt).toLocaleTimeString('en-GB')}</span></div></div>`;
    }
    html += '<div class="hi-dlg-ft"><button type="button" class="hi-btn pri" data-refresh>Refresh</button></div>';
    const body = openDialog({ title: 'Platform status', subtitle: 'Live check of this website\'s backend', bodyHtml: html, label: 'status' });
    body.querySelector('[data-refresh]').addEventListener('click', openStatus);
  }

  // ── FOOTER ──────────────────────────────────────────────────
  const shareUrl = () => location.href.split('#')[0];

  function footerHtml(i) {
    const year = new Date().getFullYear();
    const link = (href, text) => `<li><a href="${href}">${text}</a></li>`;
    return `
      <div class="ft-g">
        <div>
          <div class="ft-bn">Hospitality <em>Intelligence</em></div>
          <p class="ft-bio">Closed-loop AI attribution for UK independent restaurants — connecting social discovery, bookings, POS spend and reviews. Plans from &pound;79/mo.</p>
          <div class="ft-soc">
            <a class="fsoc" data-share="linkedin" href="#" target="_blank" rel="noopener" aria-label="Share on LinkedIn" title="Share on LinkedIn"><svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg></a>
            <a class="fsoc" data-share="x" href="#" target="_blank" rel="noopener" aria-label="Share on X" title="Share on X"><svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
            <a class="fsoc" href="mailto:${COMPANY_EMAIL}" aria-label="Email us" title="Email ${COMPANY_EMAIL}"><svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></a>
            <button type="button" class="fsoc" data-copy-link aria-label="Copy link to this page" title="Copy link"><svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button>
          </div>
          <form class="ft-nl" novalidate data-form="newsletter">
            <h5>Monthly UK hospitality insights</h5>
            <p>Attribution tips, benchmarks and pilot updates. No spam.</p>
            <div class="ft-nl-row">
              <label class="hi-hp" for="nlEmail${i}">Email address</label>
              <input class="ft-nl-in" id="nlEmail${i}" name="email" type="email" autocomplete="email" placeholder="you@restaurant.co.uk" required/>
              <button class="ft-nl-btn" type="submit">Subscribe</button>
            </div>
            <label class="ft-nl-ck"><input type="checkbox" name="consent"/><span>I agree to receive emails and can unsubscribe anytime. See our <a href="#/legal/privacy">Privacy Policy</a>.</span></label>
            <input class="hi-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"/>
            <div class="ft-msg" role="status" aria-live="polite"></div>
          </form>
        </div>
        <nav class="ft-col" aria-label="Platform"><h5>Platform</h5><ul>
          ${link('#/solution', 'Core Features')}${link('#/hiw', 'How It Works')}${link('#/demo', 'Live Demo')}${link('#/dashboard', 'Dashboard')}${link('#/market', 'Market Intel')}${link('#/pricing', 'Pricing')}
        </ul></nav>
        <nav class="ft-col" aria-label="Company"><h5>Company</h5><ul>
          ${link('#/founder', 'About the Founder')}${link('#/competitors', 'Competition')}${link('#/financials', 'Financials')}${link('#/esg', 'ESG Impact')}${link('#/faq', 'FAQ')}${link('#/contact', 'Contact &amp; Pilot')}
        </ul></nav>
        <nav class="ft-col" aria-label="Legal and trust"><h5>Legal &amp; Trust</h5><ul>
          ${link('#/legal/privacy', 'Privacy Policy')}${link('#/legal/terms', 'Terms of Service')}${link('#/legal/cookies', 'Cookie Policy')}${link('#/legal/dpa', 'Data Processing (DPA)')}${link('#/data-rights', 'Your Data Rights')}${link('#/legal/accessibility', 'Accessibility')}
        </ul></nav>
      </div>
      <div class="ft-bot">
        <p>&copy; ${year} Hospitality Intelligence Hub Ltd. Registered in England &amp; Wales. All rights reserved.</p>
        <button type="button" class="ft-badge" data-status-badge onclick="location.hash='#/status'" aria-label="View platform status"><span class="ld" style="width:5px;height:5px"></span><span data-status-text>CHECKING STATUS…</span></button>
        <div class="ft-lk"><a href="#/legal/privacy">Privacy</a><a href="#/legal/terms">Terms</a><a href="#/legal/cookies">Cookies</a><a href="#/subscription">Unsubscribe</a><button type="button" data-top>Back to top &uarr;</button></div>
      </div>`;
  }

  function renderFooters() {
    document.querySelectorAll('footer[data-site-footer]').forEach((f, i) => {
      f.innerHTML = footerHtml(i);
      f.setAttribute('aria-label', 'Site footer');
    });
  }

  async function copyLink() {
    const url = shareUrl() + '#/' + currentPage();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const t = document.createElement('textarea');
      t.value = url; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    toast('Link copied to clipboard');
  }

  function updateShareLinks() {
    const url = encodeURIComponent(shareUrl() + '#/' + currentPage());
    const text = encodeURIComponent('Hospitality Intelligence — AI revenue attribution for UK independent restaurants');
    document.querySelectorAll('[data-share="linkedin"]').forEach((a) => { a.href = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`; });
    document.querySelectorAll('[data-share="x"]').forEach((a) => { a.href = `https://x.com/intent/post?url=${url}&text=${text}`; });
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-link]')) { copyLink(); return; }
    if (e.target.closest('[data-top]')) { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.form === 'newsletter') { e.preventDefault(); submitNewsletter(form); }
    if (form.dataset.form === 'enquiry') { e.preventDefault(); submitEnquiry(form); }
  });

  // ── CONTACT / PILOT / DEMO FORM ─────────────────────────────
  const ENQUIRY_LABELS = { pilot: 'Apply for Free Pilot', demo: 'Request Demo Call', general: 'Send Message' };

  function setEnquiryType(type) {
    const form = document.querySelector('form[data-form="enquiry"]');
    if (!form) return;
    const radio = form.querySelector(`input[name="type"][value="${type}"]`);
    if (radio) radio.checked = true;
    syncEnquiryType(form);
  }

  function syncEnquiryType(form) {
    const type = form.elements.type.value;
    form.querySelector('[data-demo-only]').hidden = type !== 'demo';
    form.querySelector('button[type=submit]').textContent = ENQUIRY_LABELS[type];
  }

  // Called by the "Book a Demo Call" button on the Contact page.
  window.startEnquiry = function (type) {
    setEnquiryType(type);
    const form = document.querySelector('form[data-form="enquiry"]');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => form.elements.firstName.focus({ preventScroll: true }), 400);
  };

  async function submitEnquiry(form) {
    const f = form.elements;
    const status = form.querySelector('.form-status');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    status.className = 'form-status';
    try {
      const r = await api('/api/enquiries', { method: 'POST', body: {
        type: f.type.value, firstName: f.firstName.value, lastName: f.lastName.value, email: f.email.value,
        venue: f.venue.value, locations: f.locations.value, challenge: f.challenge.value,
        preferredTime: f.preferredTime.value, message: f.message.value, consent: f.consent.checked, website: f.website.value,
      } });
      showFieldErrors(form, {});
      form.reset();
      syncEnquiryType(form);
      status.className = 'form-status ok';
      status.innerHTML = `${esc(r.message)}<br>Your reference: <code>${esc(r.reference)}</code>`;
      toast('Enquiry ' + r.reference + ' received');
    } catch (err) {
      if (err instanceof ApiError) showFieldErrors(form, err.fields);
      status.className = 'form-status err';
      status.innerHTML = errorMessage(err);
    } finally {
      btn.disabled = false;
      syncEnquiryType(form);
    }
  }

  // ── INIT ────────────────────────────────────────────────────
  function init() {
    renderFooters();
    const enquiry = document.querySelector('form[data-form="enquiry"]');
    if (enquiry) {
      enquiry.addEventListener('change', (e) => { if (e.target.name === 'type') syncEnquiryType(enquiry); });
      syncEnquiryType(enquiry);
    }
    updateShareLinks();
    refreshStatus();
    setInterval(refreshStatus, 60000);
    if (location.hash.length > 2) route();
  }

  window.HI = { api, ApiError, OfflineError, esc, openLegal, openStatus };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
