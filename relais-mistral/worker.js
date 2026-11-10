/* SMSM Traduction : relais Mistral (Cloudflare Worker, gratuit).
   La clé Mistral reste cachée ici (secret MISTRAL_KEY) : elle n'est jamais envoyée aux navigateurs.
   Seul le site SMSM Traduction peut l'utiliser. */
const ALLOWED_ORIGINS = ["https://drewaob.github.io", "http://localhost:8790", "http://127.0.0.1:8790"];
// modèles proposés au site (du meilleur au plus rapide) ; vision = sait lire les scans
const MODELS = [
  { id: "mistral-large-latest", vision: true },
  { id: "mistral-medium-latest", vision: true },
  { id: "mistral-small-latest", vision: true },
];
const MAX_BODY = 12 * 1024 * 1024;

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { ...h, "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, h);
    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    if (req.method === "GET" && path.endsWith("/models")) return json({ object: "list", data: MODELS.map(m => ({ object: "model", ...m })) }, 200, h);

    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      if (!env.MISTRAL_KEY) return json({ error: "MISTRAL_KEY manquante" }, 500, h);
      const len = +(req.headers.get("content-length") || 0);
      if (len > MAX_BODY) return json({ error: "too large" }, 413, h);
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, h); }
      if (!MODELS.some(m => m.id === body.model)) return json({ error: "model not allowed" }, 404, h);
      // paramètres propres à OVH, inconnus de Mistral
      delete body.chat_template_kwargs; delete body.reasoning_effort;
      body.max_tokens = Math.min(+body.max_tokens || 8000, 16000);
      // images : Mistral attend image_url sous forme de texte
      for (const msg of body.messages || []) if (Array.isArray(msg.content))
        for (const part of msg.content) if (part.type === "image_url" && part.image_url && typeof part.image_url === "object") part.image_url = part.image_url.url;
      const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + env.MISTRAL_KEY },
        body: JSON.stringify(body),
      });
      const out = new Headers(h);
      out.set("content-type", r.headers.get("content-type") || "text/event-stream");
      const ra = r.headers.get("retry-after"); if (ra) out.set("retry-after", ra);
      return new Response(r.body, { status: r.status, headers: out });
    }
    return json({ error: "not found" }, 404, h);
  },
};
