/* SMSM Traduction : relais IA gratuit (Cloudflare Worker, gratuit).
   Regroupe toutes les offres gratuites pour lesquelles une clé est installée :
     GEMINI_KEY     Google Gemini API (aistudio.google.com, sans carte)
     GROQ_KEY       Groq (console.groq.com, sans carte)
     OPENROUTER_KEY OpenRouter, modèles « :free » (openrouter.ai, sans carte)
   Une seule clé suffit ; chaque clé ajoutée augmente la vitesse.
   Les clés restent cachées ici (secrets Cloudflare) : elles ne sont jamais envoyées aux navigateurs,
   et seul le site SMSM Traduction peut utiliser ce relais. */
const ALLOWED_ORIGINS = ["https://drewaob.github.io", "http://localhost:8790", "http://127.0.0.1:8790"];
const MAX_BODY = 12 * 1024 * 1024;
const BAD = /(preview|exp\b|-exp|tts|image|audio|live|embed|whisper|guard|thinking|computer|vision-only|distil|-mini\b|nano|safeguard|prompt-guard|compound|orpheus|playai)/i;
const ver = id => (id.match(/\d+(\.\d+)?/g) || []).map(Number);
const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
const size = id => { const m = /(\d+(?:\.\d+)?)b\b/i.exec(id); return m ? parseFloat(m[1]) : 100; };

const PROVIDERS = {
  gemini: {
    key: "GEMINI_KEY", base: "https://generativelanguage.googleapis.com/v1beta/openai",
    pick(ids) {
      ids = ids.map(i => i.replace(/^models\//, "")).filter(i => !BAD.test(i));
      const lite = ids.filter(i => /^gemini-[\d.]+-flash-lite$/i.test(i)).sort(newer)[0];
      const gemma = ids.filter(i => /^gemma-\d/i.test(i)).sort((a, b) => newer(a, b) || size(b) - size(a))[0];
      return [lite && { id: lite, vision: true, rpm: 14 }, gemma && { id: gemma, rpm: 28 }].filter(Boolean);
    },
  },
  groq: {
    key: "GROQ_KEY", base: "https://api.groq.com/openai/v1",
    pick(ids) {
      return ids.filter(i => !BAD.test(i) && /(llama|qwen|gpt-oss|kimi|deepseek|mistral|gemma|maverick|scout)/i.test(i) && size(i) >= 17)
        .map(i => ({ id: i, vision: /(llama-4|maverick|scout)/i.test(i), rpm: 4 })); // quota gratuit en tokens : ~4 passages/min par modèle
    },
  },
  openrouter: {
    key: "OPENROUTER_KEY", base: "https://openrouter.ai/api/v1",
    pick(ids) {
      return ids.filter(i => /:free$/.test(i) && !BAD.test(i) && size(i) >= 20).slice(0, 12)
        .map(i => ({ id: i, vision: /(vl|vision|gemma-3|llama-4|qwen2\.5-vl)/i.test(i), rpm: 4 }));
    },
  },
};

function cors(origin) {
  return { "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { ...h, "content-type": "application/json" } });

let CACHE = null;
async function models(env) {
  if (CACHE && Date.now() - CACHE.at < 6 * 3600e3) return CACHE.list;
  const list = [];
  await Promise.all(Object.entries(PROVIDERS).map(async ([name, p]) => {
    if (!env[p.key]) return;
    try {
      const r = await fetch(p.base + "/models", { headers: { authorization: "Bearer " + env[p.key] } });
      if (!r.ok) return;
      const ids = ((await r.json()).data || []).map(m => String(m.id));
      for (const m of p.pick(ids)) list.push({ ...m, id: name + "/" + m.id, provider: name });
    } catch (e) {}
  }));
  CACHE = { at: Date.now(), list };
  return list;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, h);
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    try {
      if (req.method === "GET" && path.endsWith("/models")) return json({ object: "list", data: (await models(env)).map(m => ({ object: "model", ...m })) }, 200, h);
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        if (+(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "too large" }, 413, h);
        const body = await req.json();
        const m = (await models(env)).find(x => x.id === body.model);
        if (!m) return json({ error: "model not allowed" }, 404, h);
        const p = PROVIDERS[m.provider];
        body.model = m.id.slice(m.provider.length + 1);
        delete body.chat_template_kwargs; delete body.reasoning_effort; // paramètres propres à OVH
        body.max_tokens = Math.min(+body.max_tokens || 8000, m.provider === "groq" ? 8000 : 16000);
        const r = await fetch(p.base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env[p.key], "http-referer": "https://drewaob.github.io/site-traduction/", "x-title": "SMSM Traduction" }, body: JSON.stringify(body) });
        const out = new Headers(h);
        out.set("content-type", r.headers.get("content-type") || "text/event-stream");
        if (r.status === 429) { const t = await r.text(); out.set("retry-after", /(per ?day|PerDay|daily|RPD|TPD)/i.test(t) ? "3600" : String(Math.max(2, +r.headers.get("retry-after") || 5))); return new Response(t, { status: 429, headers: out }); }
        return new Response(r.body, { status: r.status, headers: out });
      }
    } catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    return json({ error: "not found" }, 404, h);
  },
};
