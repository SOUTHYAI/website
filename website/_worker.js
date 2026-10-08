// SOUTHYAI single-file worker (Cloudflare Pages "advanced mode").
// Generated from the functions/ folder. Handles /api/*, everything else is served as static files.
// Shared helpers (not a route).
const R2_PUBLIC = 'https://pub-e61cb47c92ca41dda985058e5d87eee3.r2.dev';

const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (msg, status = 400) => json({ error: msg }, status);

const previewUrl = (key) =>
  key ? `${R2_PUBLIC}/${key.split('/').map(encodeURIComponent).join('/')}` : null;

function adminOk(request, env) {
  const given = request.headers.get('x-admin-key') || '';
  const real = env.ADMIN_SECRET || '';
  if (!real || given.length !== real.length) return false;
  let diff = 0;
  for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

function makePin() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % 32]).join('');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- contributor platform helpers ----------
const CATEGORIES = [
  { key: 'banking', label: 'Banking' },
  { key: 'investments', label: 'Investments' },
  { key: 'tech-support', label: 'Tech support' },
  { key: 'customer-service', label: 'Customer service' },
  { key: 'troubleshooting', label: 'Troubleshooting' },
];
const LANGUAGES = ['isiZulu', 'isiXhosa', 'Afrikaans', 'English', 'Sepedi', 'Sesotho', 'Setswana', 'siSwati', 'Tshivenda', 'isiNdebele', 'Xitsonga'];

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
async function currentUser(request, env) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sy_session=([a-f0-9]{64})/);
  if (!m) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')"
  ).bind(await sha256(m[1])).first();
}
async function startSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+30 days'))")
    .bind(await sha256(token), userId).run();
  return `sy_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}
async function getSetting(env, key, def) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value : def;
}
const openCategories = async (env) =>
  (await getSetting(env, 'open_categories', 'banking,customer-service')).split(',').filter(Boolean);


const M0 = (() => {
// /api/admin/config

const guard = (request, env) => {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  return null;
};

async function onRequestGet({ request, env }) {
  const g = guard(request, env); if (g) return g;
  const { results = [] } = await env.DB.prepare('SELECT category,language,COUNT(*) AS n FROM prompts WHERE active=1 GROUP BY category,language ORDER BY category,language').all();
  return json({ categories: CATEGORIES, languages: LANGUAGES, open_categories: await openCategories(env), rate_cents: Number(await getSetting(env, 'rate_cents', '0')), prompt_counts: results });
}

// POST {open_categories?:[..max 2], rate_cents?:int, prompts?:{category,language,text:"one per line"}}
async function onRequestPost({ request, env }) {
  const g = guard(request, env); if (g) return g;
  let b; try { b = await request.json(); } catch { return fail('Invalid request'); }
  const out = {};
  const put = (k, v) => env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v)).run();

  if (b.open_categories !== undefined) {
    const list = [...new Set(b.open_categories)].filter((k) => CATEGORIES.some((c) => c.key === k));
    if (list.length > 2) return fail('Only 2 categories can be open at a time');
    await put('open_categories', list.join(',')); out.open_categories = list;
  }
  if (b.rate_cents !== undefined) {
    const n = Number(b.rate_cents);
    if (!Number.isInteger(n) || n < 0) return fail('rate_cents must be a whole number like 150 (= R1.50)');
    await put('rate_cents', n); out.rate_cents = n;
  }
  if (b.prompts) {
    const { category, language, text } = b.prompts;
    if (!CATEGORIES.some((c) => c.key === category) || !LANGUAGES.includes(language)) return fail('Pick a valid category and language');
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 300).slice(0, 500);
    if (!lines.length) return fail('Paste at least one script line');
    await env.DB.batch(lines.map((l) => env.DB.prepare('INSERT INTO prompts (category,language,text) VALUES (?,?,?)').bind(category, language, l)));
    out.prompts_added = lines.length;
  }
  return json({ ok: true, ...out });
}

return { onRequestGet, onRequestPost };
})();
const M1 = (() => {
// /api/admin/confirm-payment

// POST /api/admin/confirm-payment {voice_id, customer_email, payment_reference}
// Header: x-admin-key. Creates the license + PIN and emails it. PIN is ALWAYS returned to you too.
async function onRequestPost({ request, env }) {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured (ADMIN_SECRET missing)', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  let b;
  try { b = await request.json(); } catch { return fail('Invalid request'); }

  const voice_id = String(b?.voice_id || '').trim();
  const email = String(b?.customer_email || '').trim().toLowerCase();
  const ref = String(b?.payment_reference || '').trim() || null;
  if (!voice_id || !email) return fail('voice_id and customer_email are required');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Invalid customer email');

  try {
    const v = await env.DB.prepare('SELECT * FROM voices WHERE id=?').bind(voice_id).first();
    if (!v) return fail('Voice not found', 404);

    let pin = null;
    for (let i = 0; i < 10 && !pin; i++) {
      const x = makePin();
      if (!(await env.DB.prepare('SELECT id FROM licenses WHERE license_key=?').bind(x).first())) pin = x;
    }
    if (!pin) return fail('Could not generate a unique PIN', 500);

    await env.DB.prepare(
      "INSERT INTO licenses (id,voice_id,customer_email,payment_ref,license_key,status) VALUES (?,?,?,?,?,'active')"
    ).bind(crypto.randomUUID(), voice_id, email, ref, pin).run();

    let emailed = false, warning = null;
    if (!env.RESEND_API_KEY) {
      warning = 'RESEND_API_KEY is not set, so no email was sent. Send the PIN to the customer yourself.';
    } else {
      try {
        const origin = new URL(request.url).origin;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'SOUTHYAI <support@southyai.co.za>',
            to: [email],
            subject: `Your license PIN for ${v.name}`,
            html: `<p>Your payment for <strong>${esc(v.name)}</strong> is confirmed.</p><p>Your one-time license PIN:</p><h2>${pin}</h2><p>Enter it with your email at <a href="${origin}/redeem.html">${origin}/redeem.html</a>. It can only be used once.</p>`,
          }),
        });
        emailed = r.ok;
        if (!r.ok) { console.error(await r.text()); warning = 'Email could not be sent (check Resend domain/API key). Send the PIN yourself.'; }
      } catch (e) { console.error(e); warning = 'Email could not be sent. Send the PIN yourself.'; }
    }
    return json({ ok: true, pin, emailed, warning });
  } catch (e) {
    console.error(e);
    return fail('Unable to confirm payment', 500);
  }
}

return { onRequestPost };
})();
const M2 = (() => {
// /api/admin/licenses

// GET /api/admin/licenses (header x-admin-key) -> array of sales (PINs are not listed)
async function onRequestGet({ request, env }) {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  try {
    const { results = [] } = await env.DB.prepare(
      `SELECT l.id, l.voice_id, v.name AS voice_name, l.customer_email, l.payment_ref, l.status, l.used_at, l.created_at
       FROM licenses l LEFT JOIN voices v ON v.id = l.voice_id ORDER BY l.created_at DESC LIMIT 200`
    ).all();
    return json(results);
  } catch (e) {
    console.error(e);
    return fail('Unable to load licenses', 500);
  }
}

return { onRequestGet };
})();
const M3 = (() => {
// /api/admin/payouts

const guard = (request, env) => {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  return null;
};

// GET: who is owed money (approved + unpaid), grouped per contributor
async function onRequestGet({ request, env }) {
  const g = guard(request, env); if (g) return g;
  const { results = [] } = await env.DB.prepare(
    `SELECT u.id AS user_id,u.name,u.paypal_email,COUNT(*) AS recordings,SUM(r.rate_cents) AS owed_cents,MIN(r.reviewed_at) AS oldest_approved,
       (SELECT COUNT(*) FROM users x WHERE x.referred_by=u.id) AS referrals
     FROM recordings r JOIN users u ON u.id=r.user_id
     WHERE r.status='approved' AND r.paid_at IS NULL GROUP BY u.id ORDER BY oldest_approved ASC`
  ).all();
  return json(results);
}

// POST {user_id}: after you've paid them on PayPal, mark everything currently owed as paid
async function onRequestPost({ request, env }) {
  const g = guard(request, env); if (g) return g;
  let b; try { b = await request.json(); } catch { return fail('Invalid request'); }
  const owed = await env.DB.prepare("SELECT COALESCE(SUM(rate_cents),0) AS c FROM recordings WHERE user_id=? AND status='approved' AND paid_at IS NULL").bind(String(b?.user_id || '')).first();
  const r = await env.DB.prepare("UPDATE recordings SET paid_at=datetime('now') WHERE user_id=? AND status='approved' AND paid_at IS NULL").bind(String(b?.user_id || '')).run();
  return json({ ok: true, marked: r.meta.changes, paid_cents: owed.c });
}

return { onRequestGet, onRequestPost };
})();
const M4 = (() => {
// /api/admin/recordings

const guard = (request, env) => {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  return null;
};

// GET ?status=pending|approved|rejected  -> list.   GET ?audio=ID -> streams the file
async function onRequestGet({ request, env }) {
  const g = guard(request, env); if (g) return g;
  const url = new URL(request.url);
  const audioId = url.searchParams.get('audio');
  if (audioId) {
    const r = await env.DB.prepare('SELECT r2_key FROM recordings WHERE id=?').bind(audioId).first();
    const o = r ? await env.RECORDINGS.get(r.r2_key) : null;
    if (!o) return fail('Audio not found', 404);
    return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'audio/webm', 'cache-control': 'no-store' } });
  }
  const status = ['pending', 'approved', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
  const { results = [] } = await env.DB.prepare(
    `SELECT r.id,r.category,r.language,r.duration_sec,r.status,r.created_at,u.name AS contributor,u.email,p.text AS script
     FROM recordings r JOIN users u ON u.id=r.user_id JOIN prompts p ON p.id=r.prompt_id
     WHERE r.status=? ORDER BY r.created_at ASC LIMIT 100`
  ).bind(status).all();
  return json(results);
}

// POST {id, action:'approve'|'reject', reason}
async function onRequestPost({ request, env }) {
  const g = guard(request, env); if (g) return g;
  let b; try { b = await request.json(); } catch { return fail('Invalid request'); }
  const id = String(b?.id || '');
  if (b?.action === 'approve') {
    const rate = Number(await getSetting(env, 'rate_cents', '0'));
    const r = await env.DB.prepare("UPDATE recordings SET status='approved', rate_cents=?, reviewed_at=datetime('now') WHERE id=? AND status='pending'").bind(rate, id).run();
    return r.meta.changes ? json({ ok: true, rate_cents: rate }) : fail('Already reviewed or not found', 409);
  }
  if (b?.action === 'reject') {
    const reason = String(b.reason || 'Quality not good enough').slice(0, 200);
    const r = await env.DB.prepare("UPDATE recordings SET status='rejected', reject_reason=?, reviewed_at=datetime('now') WHERE id=? AND status='pending'").bind(reason, id).run();
    return r.meta.changes ? json({ ok: true }) : fail('Already reviewed or not found', 409);
  }
  return fail('action must be approve or reject');
}

return { onRequestGet, onRequestPost };
})();
const M5 = (() => {
// /api/admin/users

const guard = (request, env) => {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  return null;
};

// GET: all contributors with referral counts. POST {id, status}: applied|approved|active|suspended
async function onRequestGet({ request, env }) {
  const g = guard(request, env); if (g) return g;
  const { results = [] } = await env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.paypal_email,u.languages,u.status,u.referral_code,u.consent_at,u.created_at,
       (SELECT COUNT(*) FROM users r WHERE r.referred_by=u.id) AS referrals,
       (SELECT COUNT(*) FROM recordings x WHERE x.user_id=u.id AND x.status='approved') AS approved,
       (SELECT COUNT(*) FROM recordings x WHERE x.user_id=u.id AND x.status='pending') AS pending
     FROM users u ORDER BY u.created_at DESC LIMIT 500`
  ).all();
  return json(results);
}

async function onRequestPost({ request, env }) {
  const g = guard(request, env); if (g) return g;
  let b; try { b = await request.json(); } catch { return fail('Invalid request'); }
  if (!['applied', 'approved', 'active', 'suspended'].includes(b?.status)) return fail('Bad status');
  const r = await env.DB.prepare('UPDATE users SET status=? WHERE id=?').bind(b.status, String(b.id || '')).run();
  if (!r.meta.changes) return fail('User not found', 404);
  if (b.status === 'suspended') await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(b.id).run();
  return json({ ok: true });
}

return { onRequestGet, onRequestPost };
})();
const M6 = (() => {
// /api/admin/voices

// POST /api/admin/voices (header x-admin-key) -> add a voice
async function onRequestPost({ request, env }) {
  if (!env?.DB || !env?.ADMIN_SECRET) return fail('Admin service is not configured', 503);
  if (!adminOk(request, env)) return fail('Wrong admin key', 401);
  let b;
  try { b = await request.json(); } catch { return fail('Invalid request'); }
  for (const f of ['name', 'language', 'preview_key', 'full_key'])
    if (typeof b?.[f] !== 'string' || !b[f].trim()) return fail(`${f} is required`);
  const price = Number(b.price_cents ?? 0);
  if (!Number.isInteger(price) || price < 0) return fail('price_cents must be a whole number like 15000 (= R150.00)');
  const t = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  try {
    const id = t(b.id) || crypto.randomUUID();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO voices (id,name,language,gender,accent,category,price_cents,preview_key,full_key,description) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, b.name.trim(), b.language.trim(), t(b.gender), t(b.accent), t(b.category), price, b.preview_key.trim(), b.full_key.trim(), t(b.description)).run();
    return json({ ok: true, id });
  } catch (e) {
    console.error(e);
    return fail('Unable to add voice', 500);
  }
}

return { onRequestPost };
})();
const M7 = (() => {
// /api/auth/[action]

const EMAIL = /^\S+@\S+\.\S+$/;

async function onRequest({ request, env, params }) {
  if (!env?.DB) return fail('Database is not configured', 503);
  const a = params.action;
  if (a === 'me' && request.method === 'GET') return me(request, env);
  if (request.method !== 'POST') return fail('Method not allowed', 405);
  let b = {};
  try { b = await request.json(); } catch { /* logout may have no body */ }
  if (a === 'register') return register(b, env);
  if (a === 'login') return login(b, env);
  if (a === 'logout') return logout(request, env);
  return fail('Not found', 404);
}

async function register(b, env) {
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().toLowerCase();
  const paypal = String(b.paypal_email || '').trim().toLowerCase();
  const pw = String(b.password || '');
  const langs = (Array.isArray(b.languages) ? b.languages : []).filter((l) => LANGUAGES.includes(l));
  if (!name) return fail('Enter your name');
  if (!EMAIL.test(email)) return fail('Enter a valid email');
  if (!EMAIL.test(paypal)) return fail('Enter the PayPal email you want to be paid on');
  if (pw.length < 8) return fail('Password must be at least 8 characters');
  if (!langs.length) return fail('Pick at least one language you speak');
  if (b.consent !== true) return fail('You must accept the consent (POPIA) to join');

  let referred_by = null;
  if (b.ref) {
    const r = await env.DB.prepare('SELECT id FROM users WHERE referral_code=?').bind(String(b.ref).trim().toUpperCase()).first();
    referred_by = r?.id || null;
  }
  const id = crypto.randomUUID(), salt = randHex(16), code = randHex(4).toUpperCase();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id,email,name,pass_hash,salt,paypal_email,languages,consent_at,referral_code,referred_by) VALUES (?,?,?,?,?,?,?,datetime('now'),?,?)"
    ).bind(id, email, name, await hashPw(pw, salt), salt, paypal, langs.join(','), code, referred_by).run();
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) return fail('That email already has an account. Log in instead.', 409);
    console.error(e); return fail('Could not create account', 500);
  }
  return json({ ok: true }, 201, { 'set-cookie': await startSession(env, id) });
}

async function login(b, env) {
  const email = String(b.email || '').trim().toLowerCase();
  const u = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  const good = u && (await hashPw(String(b.password || ''), u.salt)) === u.pass_hash;
  if (!good) return fail('Wrong email or password', 401);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, u.id) });
}

async function logout(request, env) {
  const m = (request.headers.get('cookie') || '').match(/sy_session=([a-f0-9]{64})/);
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(m[1])).run();
  return json({ ok: true }, 200, { 'set-cookie': 'sy_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

async function me(request, env) {
  const u = await currentUser(request, env);
  if (!u) return fail('Not logged in', 401);
  const open = await openCategories(env);
  const q = async (sql) => (await env.DB.prepare(sql).bind(u.id).first()) || {};
  const s = await q(`SELECT
      SUM(status='pending') AS pending, SUM(status='approved') AS approved, SUM(status='rejected') AS rejected,
      COALESCE(SUM(CASE WHEN status='approved' AND paid_at IS NULL THEN rate_cents END),0) AS owed_cents,
      COALESCE(SUM(CASE WHEN status='approved' AND paid_at IS NOT NULL THEN rate_cents END),0) AS paid_cents
    FROM recordings WHERE user_id=?`);
  const refs = await q('SELECT COUNT(*) AS n FROM users WHERE referred_by=?');
  return json({
    user: { name: u.name, email: u.email, status: u.status, languages: (u.languages || '').split(',').filter(Boolean), referral_code: u.referral_code, paypal_email: u.paypal_email },
    stats: { pending: s.pending || 0, approved: s.approved || 0, rejected: s.rejected || 0, owed_cents: s.owed_cents, paid_cents: s.paid_cents, referrals: refs.n || 0 },
    categories: CATEGORIES.map((c) => ({ ...c, open: open.includes(c.key) })),
    rate_cents: Number(await getSetting(env, 'rate_cents', '0')),
  });
}

return { onRequest };
})();
const M8 = (() => {
// /api/contribute/prompts

// GET /api/contribute/prompts?category=banking&language=isiZulu
// Closed categories still return their scripts (so people can read them) but open=false.
async function onRequestGet({ request, env }) {
  const u = await currentUser(request, env);
  if (!u) return fail('Please log in', 401);
  const url = new URL(request.url);
  const category = url.searchParams.get('category') || '';
  const language = url.searchParams.get('language') || '';
  if (!CATEGORIES.some((c) => c.key === category)) return fail('Unknown category');
  const open = (await openCategories(env)).includes(category);
  const { results = [] } = await env.DB.prepare(
    `SELECT id, text FROM prompts WHERE category=? AND language=? AND active=1
       AND id NOT IN (SELECT prompt_id FROM recordings WHERE user_id=?) ORDER BY RANDOM() LIMIT 10`
  ).bind(category, language, u.id).all();
  return json({ open, prompts: results });
}

return { onRequestGet };
})();
const M9 = (() => {
// /api/contribute/upload

// POST multipart: audio (file), prompt_id, duration
async function onRequestPost({ request, env }) {
  if (!env?.DB || !env?.RECORDINGS) return fail('Recording storage is not configured', 503);
  const u = await currentUser(request, env);
  if (!u) return fail('Please log in', 401);
  if (u.status !== 'active')
    return fail('You cannot record yet. Contact support@southyai.co.za for induction and to sign your freelancer contract.', 403);

  let form;
  try { form = await request.formData(); } catch { return fail('Invalid upload'); }
  const audio = form.get('audio');
  const promptId = Number(form.get('prompt_id'));
  const duration = Number(form.get('duration'));
  if (!audio || typeof audio === 'string' || !String(audio.type).startsWith('audio/')) return fail('No audio received');
  if (audio.size < 2000) return fail('Recording is too short or empty. Try again.');
  if (audio.size > 8 * 1024 * 1024) return fail('Recording is too large (max 8MB)');
  if (!(duration >= 1 && duration <= 120)) return fail('Recording must be between 1 and 120 seconds');

  const p = await env.DB.prepare('SELECT * FROM prompts WHERE id=? AND active=1').bind(promptId).first();
  if (!p) return fail('Script not found', 404);
  if (!(await openCategories(env)).includes(p.category)) return fail('This category is not open for recording yet', 403);
  if (!(u.languages || '').split(',').includes(p.language)) return fail('That language is not on your profile', 403);

  const id = crypto.randomUUID();
  const ext = /webm/.test(audio.type) ? 'webm' : /mp4|aac|m4a/.test(audio.type) ? 'm4a' : /ogg/.test(audio.type) ? 'ogg' : /wav/.test(audio.type) ? 'wav' : 'bin';
  const key = `recordings/${u.id}/${id}.${ext}`;
  try {
    await env.DB.prepare('INSERT INTO recordings (id,user_id,prompt_id,category,language,r2_key,duration_sec) VALUES (?,?,?,?,?,?,?)')
      .bind(id, u.id, p.id, p.category, p.language, key, duration).run();
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) return fail('You already recorded this script', 409);
    console.error(e); return fail('Could not save recording', 500);
  }
  try {
    await env.RECORDINGS.put(key, audio.stream(), { httpMetadata: { contentType: audio.type } });
  } catch (e) {
    console.error(e);
    await env.DB.prepare('DELETE FROM recordings WHERE id=?').bind(id).run();
    return fail('Upload failed. Please try again.', 500);
  }
  return json({ ok: true, id }, 201);
}

return { onRequestPost };
})();
const M10 = (() => {
// /api/redeem

// POST /api/redeem {email, pin} -> the audio file. A PIN works exactly once.
async function onRequestPost({ request, env }) {
  if (!env?.DB || !env?.R2) return fail('Licensing service is not configured', 503);
  let b;
  try { b = await request.json(); } catch { return fail('Invalid request'); }
  const email = String(b?.email || '').trim().toLowerCase();
  const pin = String(b?.pin || '').replace(/[\s-]/g, '').toUpperCase();
  if (!email || !pin) return fail('Email and PIN are required');

  try {
    const l = await env.DB.prepare(
      "SELECT * FROM licenses WHERE license_key=? AND lower(customer_email)=? AND status='active'"
    ).bind(pin, email).first();
    if (!l) return fail('Invalid PIN or email', 403);
    if (l.used_at) return fail('This PIN has already been used', 410);

    const v = await env.DB.prepare('SELECT * FROM voices WHERE id=?').bind(l.voice_id).first();
    const obj = v?.full_key ? await env.R2.get(v.full_key) : null;
    // File check happens BEFORE the PIN is burned, so a missing file never costs the customer their PIN
    if (!obj) return fail('Licensed file not found. Your PIN was NOT used. Please contact support@southyai.co.za', 404);

    // Atomic claim: only one request can ever win this
    const claim = await env.DB.prepare('UPDATE licenses SET used_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL').bind(l.id).run();
    if (!claim.meta.changes) return fail('This PIN has already been used', 410);
    await env.DB.prepare('INSERT INTO downloads (license_key) VALUES (?)').bind(pin).run();

    const ext = (v.full_key.split('.').pop() || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'wav';
    const type = obj.httpMetadata?.contentType || (ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    const name = String(v.name || 'southyai-voice').replace(/[^a-zA-Z0-9._-]+/g, '_');
    return new Response(obj.body, {
      headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}.${ext}"`, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.error(e);
    return fail('Unable to redeem license', 500);
  }
}

return { onRequestPost };
})();
const M11 = (() => {
// /api/voices

// GET /api/voices -> { voices: [...] }  (full_key is never exposed)
async function onRequestGet({ env }) {
  if (!env?.DB) return fail('Database is not configured', 503);
  try {
    const { results = [] } = await env.DB.prepare(
      'SELECT id,name,language,gender,accent,category,price_cents,preview_key,description FROM voices ORDER BY language,name'
    ).all();
    const voices = results.map(({ preview_key, ...v }) => ({ ...v, preview_url: previewUrl(preview_key) }));
    return json({ voices });
  } catch (e) {
    console.error(e);
    return fail('Unable to load voices', 500);
  }
}

return { onRequestGet };
})();
const M12 = (() => {
// /api/voices/[id]

// GET /api/voices/:id -> one voice (no full_key)
async function onRequestGet({ env, params }) {
  if (!env?.DB) return fail('Database is not configured', 503);
  const id = typeof params?.id === 'string' ? params.id.trim() : '';
  if (!id) return fail('Voice ID is required');
  try {
    const v = await env.DB.prepare('SELECT * FROM voices WHERE id=?').bind(id).first();
    if (!v) return fail('Voice not found', 404);
    const { full_key, preview_key, ...safe } = v;
    return json({ ...safe, preview_url: previewUrl(preview_key) });
  } catch (e) {
    console.error(e);
    return fail('Unable to load voice', 500);
  }
}

return { onRequestGet };
})();

const ROUTES = [
  [new RegExp("^/api/admin/config/?$"), M0, []],
  [new RegExp("^/api/admin/confirm\\-payment/?$"), M1, []],
  [new RegExp("^/api/admin/licenses/?$"), M2, []],
  [new RegExp("^/api/admin/payouts/?$"), M3, []],
  [new RegExp("^/api/admin/recordings/?$"), M4, []],
  [new RegExp("^/api/admin/users/?$"), M5, []],
  [new RegExp("^/api/admin/voices/?$"), M6, []],
  [new RegExp("^/api/contribute/prompts/?$"), M8, []],
  [new RegExp("^/api/contribute/upload/?$"), M9, []],
  [new RegExp("^/api/redeem/?$"), M10, []],
  [new RegExp("^/api/voices/?$"), M11, []],
  [new RegExp("^/api/auth/([^/]+)/?$"), M7, ["action"]],
  [new RegExp("^/api/voices/([^/]+)/?$"), M12, ["id"]]
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/debug-bindings') {
      const has = (k) => env[k] !== undefined && env[k] !== null;
      let dbQuery = 'skipped (no DB)';
      if (has('DB')) { try { const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM voices').first(); dbQuery = 'ok, voices rows: ' + r.n; } catch (e) { dbQuery = 'DB found but query failed: ' + String(e.message || e); } }
      return new Response(JSON.stringify({ DB: has('DB'), R2: has('R2'), RECORDINGS: has('RECORDINGS'), ADMIN_SECRET: has('ADMIN_SECRET'), RESEND_API_KEY: has('RESEND_API_KEY'), ASSETS: has('ASSETS'), dbQuery, allBindingNamesSeen: Object.keys(env) }, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    for (const [re, mod, names] of ROUTES) {
      const m = url.pathname.match(re);
      if (!m) continue;
      const params = {};
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      const handler = mod['onRequest' + request.method[0] + request.method.slice(1).toLowerCase()] || mod.onRequest;
      if (!handler) return fail('Method not allowed', 405);
      try {
        return await handler({ request, env, params, waitUntil: (p) => ctx.waitUntil(p) });
      } catch (e) {
        console.error(e);
        return fail('Server error', 500);
      }
    }
    return fail('Not found', 404);
  },
};
