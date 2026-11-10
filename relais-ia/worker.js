/* SMSM Traduction : relais IA rapide (Cloudflare Worker, gratuit).
   Fournisseur : Google Gemini API, offre gratuite (sans carte bancaire).
   La clé reste cachée ici (secret GEMINI_KEY) : elle n'est jamais envoyée aux navigateurs,
   et seul le site SMSM Traduction peut utiliser ce relais. */
const ALLOWED_ORIGINS = ["https://drewaob.github.io", "http://localhost:8790", "http://127.0.0.1:8790"];
const UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/openai";
const MAX_BODY = 12 * 1024 * 1024;

function cors(origin) {
  return {
    "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { ...h, "content-type": "application/json" } });
const ver = id => (id.match(/\d+(\.\d+)?/g) || []).map(Number);
const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); } return 0; };

// choisit les modèles gratuits les plus généreux : Gemini Flash-Lite (lit aussi les scans) et Gemma (gros quota)
async function pickModels(env) {
  const r = await fetch(UPSTREAM + "/models", { headers: { authorization: "Bearer " + env.GEMINI_KEY } });
  if (!r.ok) throw new Error("models " + r.status);
  const ids = ((await r.json()).data || []).map(m => String(m.id).replace(/^models\//, ""));
  const stable = ids.filter(id => !/(preview|exp|tts|image|audio|live|embed|thinking|computer)/i.test(id));
  const lite = stable.filter(id => /^gemini-[\d.]+-flash-lite$/i.test(id)).sort(newer)[0];
  const gemma = stable.filter(id => /^gemma-\d/i.test(id)).sort((a, b) => newer(a, b) || (parseFloat((b.match(/(\d+)b/i) || [])[1] || 0) - parseFloat((a.match(/(\d+)b/i) || [])[1] || 0)))[0];
  const out = [];
  if (lite) out.push({ id: lite, vision: true, rpm: 14 });
  if (gemma) out.push({ id: gemma, vision: false, rpm: 28 });
  return out;
}
let CACHE = null;
async function models(env) {
  if (!CACHE || Date.now() - CACHE.at > 6 * 3600e3) CACHE = { at: Date.now(), list: await pickModels(env) };
  return CACHE.list;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, h);
    if (!env.GEMINI_KEY) return json({ error: "GEMINI_KEY manquante" }, 500, h);
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    try {
      if (req.method === "GET" && path.endsWith("/models")) return json({ object: "list", data: (await models(env)).map(m => ({ object: "model", ...m })) }, 200, h);
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        if (+(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "too large" }, 413, h);
        const body = await req.json();
        if (!(await models(env)).some(m => m.id === body.model)) return json({ error: "model not allowed" }, 404, h);
        delete body.chat_template_kwargs; delete body.reasoning_effort; // paramètres propres à OVH
        body.max_tokens = Math.min(+body.max_tokens || 8000, 16000);
        const r = await fetch(UPSTREAM + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + env.GEMINI_KEY },
          body: JSON.stringify(body),
        });
        const out = new Headers(h);
        out.set("content-type", r.headers.get("content-type") || "text/event-stream");
        // quota du jour épuisé : on le dit au site pour qu'il passe sur OVH
        if (r.status === 429) { const t = await r.text(); out.set("retry-after", /per ?day|PerDay/i.test(t) ? "3600" : "5"); return new Response(t, { status: 429, headers: out }); }
        return new Response(r.body, { status: r.status, headers: out });
      }
    } catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    return json({ error: "not found" }, 404, h);
  },
};
