/*
 * SMSM Traduction — serveur Cloudflare Workers (offre gratuite)
 *
 * Réserve de moteurs gratuits (modèles ouverts), utilisés à tour de rôle :
 *  - Mistral (offre Experiment)   : très gros volume mensuel, excellent en français — les requêtes peuvent servir à l'entraînement
 *  - Cerebras                      : environ 1 million de jetons par jour (gpt-oss-120b)
 *  - Groq                          : environ 1 000 requêtes par jour (Llama 3.3 70B) + lecture des scans
 *  - NVIDIA                        : crédits gratuits (Llama 3.3 70B)
 *  - Cloudflare Workers AI         : inclus, sans clé, 10 000 « neurons » par jour
 * Quand un moteur atteint sa limite, il est mis en pause et le suivant prend le relais.
 *
 * Données (comptes, lexiques, propositions de termes, réglages) : Workers KV.
 */
import SEED_CATECHESE from "../data/seed/catechese.json";
const SEEDS = { catechese: SEED_CATECHESE };

const WORKERS_MODELS = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B (meilleure qualité)",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1 24B (plus de volume)",
};
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (code, status) => json({ code }, status);

/* ---------- KV helpers ---------- */
async function kget(env, key, fallback = null) { const v = await env.DATA.get(key, "json"); return v ?? fallback; }
async function kput(env, key, val) { await env.DATA.put(key, JSON.stringify(val)); }

async function getSecret(env) {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  let s = await env.DATA.get("secret");
  if (!s) {
    s = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.DATA.put("secret", s);
  }
  return s;
}
const PROVIDERS = {
  mistral:  { label: "Mistral", base: "https://api.mistral.ai/v1", key: "MISTRAL_API_KEY", model: e => e.MISTRAL_MODEL || "mistral-small-latest", vision: e => e.MISTRAL_MODEL || "mistral-small-latest", site: "console.mistral.ai" },
  cerebras: { label: "Cerebras", base: "https://api.cerebras.ai/v1", key: "CEREBRAS_API_KEY", model: e => e.CEREBRAS_MODEL || "gpt-oss-120b", extra: { reasoning_effort: "low" }, site: "cloud.cerebras.ai" },
  groq:     { label: "Groq", base: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY", model: e => e.GROQ_MODEL || "llama-3.3-70b-versatile", vision: e => e.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct", site: "console.groq.com" },
  nvidia:   { label: "NVIDIA", base: "https://integrate.api.nvidia.com/v1", key: "NVIDIA_API_KEY", model: e => e.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct", site: "build.nvidia.com" },
  ovh:      { label: "OVHcloud (sans clé)", base: "", key: "OVH_API_KEY", optionalKey: true, model: e => ovhModels(e)[0], site: "" },
  workers:  { label: "Cloudflare Workers AI", site: "" },
};
const ovhBase = e => (e.OVH_BASE || "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1").replace(/\/+$/, "");
const ovhModels = e => (e.OVH_MODELS || "gpt-oss-120b,Meta-Llama-3_3-70B-Instruct,Mistral-Small-3.2-24B-Instruct-2506").split(",").map(x => x.trim()).filter(Boolean);
const DEFAULT_ORDER = ["mistral", "cerebras", "groq", "nvidia", "ovh", "workers"];
const hasKey = (env, k) => k === "workers" || !!PROVIDERS[k].optionalKey || !!env[PROVIDERS[k].key];
async function getConfig(env) {
  const c = await kget(env, "config", {});
  const off = (c.off || []).filter(k => k in PROVIDERS);
  const all = [...new Set([...(c.all || DEFAULT_ORDER), ...DEFAULT_ORDER])].filter(k => k in PROVIDERS);
  return {
    all, off,
    order: all.filter(k => !off.includes(k)),
    workersModel: c.workersModel || env.WORKERS_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  };
}
async function getProject(env, id) {
  let p = await kget(env, "project:" + id);
  if (!p && SEEDS[id]) { p = { ...structuredClone(SEEDS[id]), version: 1 }; await kput(env, "project:" + id, p); }
  return p;
}
async function listProjectIds(env) {
  const ids = new Set(Object.keys(SEEDS));
  const l = await env.DATA.list({ prefix: "project:" });
  l.keys.forEach(k => ids.add(k.name.slice(8)));
  return [...ids];
}
async function saveProject(env, p, user, reason) {
  p.version = (p.version || 0) + 1;
  p.updatedAt = new Date().toISOString();
  p.updatedBy = user;
  p.lastChange = reason;
  await kput(env, "project:" + p.id, p);
  return p;
}

/* ---------- passwords & sessions ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
async function hashPassword(pw) { const salt = crypto.getRandomValues(new Uint8Array(16)); return hex(salt) + ":" + await pbkdf2(pw, salt); }
async function checkPassword(pw, stored) {
  const [s, h] = String(stored || "").split(":");
  if (!s || !h) return false;
  const got = await pbkdf2(pw, unhex(s));
  let diff = got.length ^ h.length;
  for (let i = 0; i < Math.min(got.length, h.length); i++) diff |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return diff === 0;
}
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(await getSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const SESSION_DAYS = 14;
async function makeToken(env, user) {
  const body = b64u(enc.encode(JSON.stringify({ u: user, e: Date.now() + SESSION_DAYS * 864e5 })));
  return body + "." + await hmac(env, body);
}
async function readSession(env, req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)smsm_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = decodeURIComponent(m[1]).split(".");
  if (!body || !sig || sig !== await hmac(env, body)) return null;
  try {
    const d = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (d.e < Date.now()) return null;
    const users = await kget(env, "users", {});
    const u = users[d.u];
    return u ? { name: d.u, admin: !!u.admin } : null;
  } catch { return null; }
}
const sessionCookie = (val, maxAge) => `smsm_session=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const validName = n => /^[a-z0-9._-]{2,40}$/.test(n);

/* ---------- rate limit (per isolate, best effort) ---------- */
const RL = new Map();
function acquire(user) {
  const now = Date.now();
  const s = RL.get(user) || { hits: [], active: 0 };
  s.hits = s.hits.filter(t => now - t < 60000);
  if (s.hits.length >= 30 || s.active >= 3) return null;
  s.hits.push(now); s.active++; RL.set(user, s);
  return () => { s.active = Math.max(0, s.active - 1); };
}

/* ---------- engines ---------- */
class EngineError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function* sse(body) {
  const dec = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); yield line; }
  }
  if (buf) yield buf;
}
async function* workersEngine(env, cfg, { input, images }) {
  if (images.length) throw new EngineError("images_unavailable", "Workers AI: images non prises en charge ici");
  let stream;
  try {
    stream = await env.AI.run(cfg.workersModel, { messages: [{ role: "user", content: input }], max_tokens: 4096, stream: true });
  } catch (e) {
    const m = String(e && e.message || e);
    throw new EngineError(/neuron|daily|allocation|quota|limit|429|4006/i.test(m) ? "quota" : /too long|context|token/i.test(m) ? "prompt_too_large" : "upstream_error", "Workers AI: " + m);
  }
  for await (const line of sse(stream)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") break;
    let d; try { d = JSON.parse(raw); } catch { continue; }
    const t = d.response ?? (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content);
    if (t) yield { text: t };
    const fin = d.choices && d.choices[0] && d.choices[0].finish_reason;
    if (fin === "length") yield { truncated: true };
  }
}
async function* compatEngine(env, cfg, { input, images, signal }, key) {
  const P = PROVIDERS[key];
  const apiKey = env[P.key];
  if (!apiKey && !P.optionalKey) throw new EngineError("not_configured", P.label + " non configuré");
  const base = key === "ovh" ? ovhBase(env) : P.base;
  if (images.length && !P.vision) throw new EngineError("images_unavailable", P.label + " : pas d'images");
  const model = images.length ? P.vision(env) : P.model(env);
  const content = images.length ? [{ type: "text", text: input }, ...images.map(u => ({ type: "image_url", image_url: { url: u } }))] : input;
  const call = extra => fetch(base + "/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: "Bearer " + apiKey } : {}) },
    body: JSON.stringify({ model, stream: true, max_tokens: 8000, temperature: 0.2, messages: [{ role: "user", content }], ...(extra || {}) }),
  });
  let res = await call(P.extra);
  if (res.status === 400 && P.extra) res = await call(null);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const daily = /day|daily|quota|exceed|limit|credit/i.test(t);
    throw new EngineError(res.status === 429 || res.status === 402 ? (daily ? "quota" : "rate_limited") : res.status === 413 ? "prompt_too_large" : res.status === 401 || res.status === 403 ? "engine_auth" : "upstream_error", P.label + " " + res.status + " " + t.slice(0, 200));
  }
  for await (const line of sse(res.body)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") break;
    let d; try { d = JSON.parse(raw); } catch { continue; }
    const c = d.choices && d.choices[0];
    if (c && c.delta && typeof c.delta.content === "string" && c.delta.content) yield { text: c.delta.content };
    if (c && c.finish_reason === "length") yield { truncated: true };
  }
}
// Moteur factice pour les tests locaux uniquement (wrangler dev --var MOCK_ENGINE:1)
async function* mockEngine(env, cfg, { input }) {
  const segs = [...input.matchAll(/<s id="(\d+)">([\s\S]*?)<\/s>/g)];
  const out = segs.length
    ? "@@LANG=ar\n" + segs.map(m => `<s id="${m[1]}">` + m[2].replace(/[\u0600-\u06FF]+(\s+[\u0600-\u06FF]+)*/g, "texte traduit") + "</s>").join("\n")
    : /Reply with only JSON/.test(input) ? '{"verdict":"ok","summary":"Test","issues":[]}' : "@@LANG=ar\nTraduction de test.";
  for (const part of out.match(/[\s\S]{1,40}/g)) yield { text: part };
}
const ENGINES = { workers: workersEngine, mock: mockEngine };
for (const k of Object.keys(PROVIDERS)) if (k !== "workers") ENGINES[k] = (env, cfg, args) => compatEngine(env, cfg, args, k);
// pause d'un moteur saturé (par instance du serveur) : 2 min si débit, 3 h si quota du jour
const COOLDOWN = new Map();
const cooling = k => (COOLDOWN.get(k) || 0) > Date.now();
function coolDown(k, code) { COOLDOWN.set(k, Date.now() + (code === "quota" ? 3 * 3600e3 : code === "engine_auth" ? 600e3 : 120e3)); }
function engineLabel(env, cfg, key) {
  if (key === "workers") return "Cloudflare Workers AI · " + (WORKERS_MODELS[cfg.workersModel] || cfg.workersModel);
  return PROVIDERS[key].label + " · " + PROVIDERS[key].model(env);
}
function activeOrder(env, cfg) { return cfg.order.filter(k => hasKey(env, k)); }

async function translate(env, req, user) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.input !== "string" || !b.input.trim()) return err("invalid_request", 400);
  if (b.input.length > 200000) return err("prompt_too_large", 413);
  const images = Array.isArray(b.images) ? b.images.slice(0, 3).filter(u => /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u)) : [];
  const cfg = await getConfig(env);
  let order = env.MOCK_ENGINE === "1" ? ["mock"] : activeOrder(env, cfg);
  if (images.length) order = order.filter(k => PROVIDERS[k] && PROVIDERS[k].vision);
  // les moteurs en pause passent en dernier (on les retente seulement si tous les autres échouent)
  order = [...order.filter(k => !cooling(k)), ...order.filter(k => cooling(k))];
  if (!order.length) return err(images.length ? "images_unavailable" : "not_configured", 400);
  const release = acquire(user.name);
  if (!release) return err("rate_limited", 429);

  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const run = async () => {
    let sent = false, lastErr = null;
    try {
      for (const key of order) {
        try {
          for await (const ev of ENGINES[key](env, cfg, { input: b.input, images, signal: req.signal })) {
            if (ev.text) { sent = true; await w.write(enc.encode(ev.text)); }
            if (ev.truncated) await w.write(enc.encode("\u0000END:max_tokens"));
          }
          if (sent) { lastErr = null; break; }
        } catch (e) {
          lastErr = e;
          if (["quota", "rate_limited", "engine_auth"].includes(e.code)) coolDown(key, e.code);
          console.log(`[translate] ${user.name} ${key}: ${e.message}`);
          if (sent) break;            // déjà commencé : on ne relance pas sur un autre moteur
        }
      }
      if (lastErr || !sent) await w.write(enc.encode("\u0000ERR:" + (lastErr ? (lastErr.code || "upstream_error") : "empty_completion")));
    } finally { release(); await w.close().catch(() => {}); }
  };
  const p = run();
  return { response: new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }), wait: p };
}

/* ---------- router ---------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try { return await api(req, env, ctx, url); }
    catch (e) { console.log("api error", e && e.stack || e); return err("upstream_error", 500); }
  },
};

async function api(req, env, ctx, url) {
  const path = url.pathname.slice(4);
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== url.host) return err("forbidden", 403);
  }

  /* public */
  if (path === "/state" && method === "GET") {
    const users = await kget(env, "users", {});
    return json({ setupNeeded: !Object.keys(users).length });
  }
  if (path === "/setup" && method === "POST") {
    const users = await kget(env, "users", {});
    if (Object.keys(users).length) return err("forbidden", 403);
    const b = await req.json().catch(() => ({}));
    const name = String(b.user || "").trim().toLowerCase();
    if (!validName(name) || String(b.password || "").length < 10) return err("invalid_request", 400);
    users[name] = { hash: await hashPassword(String(b.password)), admin: true, created: new Date().toISOString() };
    await kput(env, "users", users);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeToken(env, name), SESSION_DAYS * 86400) });
  }
  if (path === "/login" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const name = String(b.user || "").trim().toLowerCase();
    const ip = req.headers.get("cf-connecting-ip") || "?";
    const tries = (await kget(env, "tries:" + ip, 0)) || 0;
    if (tries >= 8) return err("rate_limited", 429);
    const users = await kget(env, "users", {});
    if (!users[name] || !(await checkPassword(String(b.password || ""), users[name].hash))) {
      ctx.waitUntil(env.DATA.put("tries:" + ip, String(tries + 1), { expirationTtl: 900 }));
      return err("bad_login", 401);
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeToken(env, name), SESSION_DAYS * 86400) });
  }
  if (path === "/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

  /* authenticated */
  const user = await readSession(env, req);
  if (!user) return err("session_expired", 401);
  const needAdmin = () => user.admin ? null : err("forbidden", 403);

  if (path === "/me" && method === "GET") {
    const cfg = await getConfig(env);
    const order = activeOrder(env, cfg);
    const vision = order.some(k => PROVIDERS[k].vision);
    return json({
      user: user.name, admin: user.admin,
      engine: { label: order.map(k => PROVIDERS[k].label).join(" · "), vision, maxImages: vision ? 3 : 0, kind: "free",
        // OVH anonyme : appelé d'abord depuis le navigateur de chaque traducteur (quota par adresse IP)
        ovh: order.includes("ovh") && !env.OVH_API_KEY ? { base: ovhBase(env), models: ovhModels(env) } : null },
    });
  }
  if (path === "/me/password" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const users = await kget(env, "users", {});
    if (!(await checkPassword(String(b.current || ""), users[user.name].hash))) return err("bad_login", 401);
    if (String(b.password || "").length < 10) return err("invalid_request", 400);
    users[user.name].hash = await hashPassword(String(b.password));
    await kput(env, "users", users);
    return json({ ok: true });
  }
  if (path === "/translate" && method === "POST") {
    const r = await translate(env, req, user);
    if (r instanceof Response) return r;
    ctx.waitUntil(r.wait);
    return r.response;
  }

  /* projects */
  if (path === "/projects" && method === "GET") {
    const out = [];
    for (const id of await listProjectIds(env)) { const p = await getProject(env, id); if (p) out.push({ id: p.id, name: p.name, terms: (p.lex || []).length }); }
    return json(out);
  }
  let m = path.match(/^\/projects\/([a-z0-9-]{1,40})(\/[a-z]+)?$/);
  if (m) {
    const id = m[1], sub = m[2] || "";
    if (method === "GET" && !sub) { const p = await getProject(env, id); return p ? json(p) : err("not_found", 404); }
    const deny = needAdmin(); if (deny) return deny;
    if (method === "PUT" && !sub) {
      const b = await req.json().catch(() => ({}));
      const p = (await getProject(env, id)) || { id, name: { fr: String(b.nameFr || "Lexique importé"), ar: String(b.nameAr || "مسرد مستورد") }, langs: ["ar", "fr"], instr: "", lex: [], conv: [] };
      if (typeof b.instr === "string") p.instr = b.instr.slice(0, 50000);
      if (Array.isArray(b.lex)) p.lex = b.lex.slice(0, 20000).map(cleanTerm).filter(e => e.src && e.tgt);
      if (Array.isArray(b.conv)) p.conv = b.conv.slice(0, 2000).map(c => ({ k: String(c.k || "").slice(0, 500), rule: String(c.rule || "").slice(0, 4000) })).filter(c => c.k);
      return json(await saveProject(env, p, user.name, Array.isArray(b.lex) ? "lexique importé" : "consignes modifiées"));
    }
    if (method === "POST" && sub === "/terms") {
      const t = cleanTerm(await req.json().catch(() => ({})));
      if (!t.src || !t.tgt) return err("invalid_request", 400);
      const p = await getProject(env, id); if (!p) return err("not_found", 404);
      if (p.lex.some(e => e.src === t.src)) return json({ code: "exists", project: p }, 409);
      t.origin = t.origin || `Ajouté par ${user.name} – ${new Date().toLocaleDateString("fr-FR")}`;
      p.lex.push(t);
      return json(await saveProject(env, p, user.name, "terme ajouté : " + t.src));
    }
    if (method === "POST" && sub === "/reset") {
      if (!SEEDS[id]) return err("not_found", 404);
      const cur = await getProject(env, id);
      const p = { ...structuredClone(SEEDS[id]), version: cur ? cur.version : 0 };
      return json(await saveProject(env, p, user.name, "lexique d'origine rétabli"));
    }
  }

  /* term proposals (any translator proposes, admin decides) */
  if (path === "/proposals" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const t = cleanTerm(b.term || {});
    if (!t.src || !t.tgt || !/^[a-z0-9-]{1,40}$/.test(b.project || "")) return err("invalid_request", 400);
    const list = await kget(env, "proposals", []);
    if (list.some(x => x.project === b.project && x.term.src === t.src)) return json({ ok: true, duplicate: true });
    list.push({ id: crypto.randomUUID(), project: b.project, term: t, by: user.name, at: new Date().toISOString(), context: String(b.context || "").slice(0, 600) });
    await kput(env, "proposals", list.slice(-500));
    return json({ ok: true });
  }
  if (path === "/proposals" && method === "GET") { const deny = needAdmin(); if (deny) return deny; return json(await kget(env, "proposals", [])); }
  m = path.match(/^\/proposals\/([0-9a-f-]{36})\/(accept|reject)$/);
  if (m && method === "POST") {
    const deny = needAdmin(); if (deny) return deny;
    const list = await kget(env, "proposals", []);
    const i = list.findIndex(x => x.id === m[1]);
    if (i < 0) return err("not_found", 404);
    const [pr] = list.splice(i, 1);
    let project = null;
    if (m[2] === "accept") {
      const edited = cleanTerm({ ...pr.term, ...(await req.json().catch(() => ({}))) });
      const p = await getProject(env, pr.project);
      if (p && !p.lex.some(e => e.src === edited.src)) {
        edited.origin = `Proposé par ${pr.by}, validé par ${user.name} – ${new Date().toLocaleDateString("fr-FR")}`;
        p.lex.push(edited);
        project = await saveProject(env, p, user.name, "terme validé : " + edited.src);
      }
    }
    await kput(env, "proposals", list);
    return json({ ok: true, project, proposals: list });
  }

  /* team */
  if (path === "/users") {
    const deny = needAdmin(); if (deny) return deny;
    const users = await kget(env, "users", {});
    if (method === "GET") return json(Object.entries(users).map(([n, u]) => ({ name: n, admin: !!u.admin, created: u.created || null })));
    if (method === "POST") {
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").trim().toLowerCase();
      if (!validName(name) || String(b.password || "").length < 10) return err("invalid_request", 400);
      users[name] = { hash: await hashPassword(String(b.password)), admin: !!b.admin, created: (users[name] && users[name].created) || new Date().toISOString() };
      await kput(env, "users", users);
      return json({ ok: true });
    }
  }
  m = path.match(/^\/users\/([a-z0-9._-]{2,40})$/);
  if (m && method === "DELETE") {
    const deny = needAdmin(); if (deny) return deny;
    if (m[1] === user.name) return err("forbidden", 403);
    const users = await kget(env, "users", {});
    delete users[m[1]];
    await kput(env, "users", users);
    return json({ ok: true });
  }
  if (path === "/config") {
    const deny = needAdmin(); if (deny) return deny;
    if (method === "GET") {
      const cfg = await getConfig(env);
      return json({ ...cfg, workersModels: WORKERS_MODELS, providers: Object.keys(PROVIDERS).map(k => ({ id: k, label: PROVIDERS[k].label, model: k === "workers" ? (WORKERS_MODELS[cfg.workersModel] || cfg.workersModel) : PROVIDERS[k].model(env), ready: hasKey(env, k), vision: !!PROVIDERS[k].vision, site: PROVIDERS[k].site, cooling: cooling(k) })) });
    }
    if (method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const cfg = await getConfig(env);
      if (Array.isArray(b.all)) cfg.all = [...new Set(b.all.filter(k => k in PROVIDERS))];
      if (Array.isArray(b.off)) cfg.off = [...new Set(b.off.filter(k => k in PROVIDERS))];
      delete cfg.order;
      if (b.workersModel in WORKERS_MODELS) cfg.workersModel = b.workersModel;
      await kput(env, "config", cfg);
      return json(await getConfig(env));
    }
  }
  return err("not_found", 404);
}
function cleanTerm(t) {
  const s = v => String(v ?? "").slice(0, 2000).trim();
  return { cat: s(t.cat), src: s(t.src), tgt: s(t.tgt), extra: s(t.extra), note: s(t.note), origin: s(t.origin) };
}
