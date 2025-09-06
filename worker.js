// x-for-y-summary worker with KV rate limiting + robust JSON parsing + quip

export default {
    async fetch(request, env) {
      // Debug endpoint - must be first
      if (typeof request.url === 'string' && request.url.includes('/debug')) {
        return json({
          status: 'debug',
          ai_available: !!env.AI,
          models: await env.AI.list(),
          bindings: Object.keys(env),
          runtime: 'Cloudflare Worker'
        }, 200, request);
      }

      // Debug endpoint (GET /debug)
      const url = new URL(request.url);
      if (url.pathname.includes('/debug') && request.method === 'GET') {
        try {
          return json({
            status: 'debug',
            ai_available: !!env.AI,
            bindings: Object.keys(env),
            cf: request.cf || {},
            headers: Object.fromEntries(request.headers)
          }, 200, request);
        } catch (e) {
          return json({error: String(e), stack: e.stack}, 500, request);
        }
      }

      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }

      if (request.method !== "POST") {
        return new Response("Use POST", { status: 405, headers: corsHeaders(request) });
      }

      // ---- Rate limit (per IP, per minute) ----
      const ok = await rateLimit(env, request);
      if (!ok) {
        return json({ error: "Rate limit exceeded. Try again in a minute." }, 429, request);
      }

      try {
        // Parse body
        const { app, niche, wants_quip } = await request.json();

        // Basic input sanitation
        const a = String(app || "").trim().slice(0, 60);
        const n = String(niche || "").trim().slice(0, 80);
        if (!a || !n) return json({ error: "Missing 'app' or 'niche'." }, 400, request);

        // Model and prompt
        const model = "@cf/meta/llama-2-7b-chat-int8"; // Fallback model
        const userPrompt = `
  You are helping write startup blurbs. Follow all rules.
  
  Rules:
  - Be clear and practical. Plain English.
  - No emojis. No hashtags. No exclamation marks.
  - No em dashes. Use periods or commas.
  - Keep the tone confident and realistic.
  
  Task:
  For "${a} for ${n}", produce a STRICT JSON object with keys "summary" and "quip".
  1) "summary": 120-160 words of markdown that contains:
     - **Executive Summary:** one short paragraph that sounds novel and feasible.
     - **Business Model:** a numbered list with 2-3 items.
  2) "quip": one sarcastic, pithy PG-13 one-liner reacting to the combo, 6-12 words, dry and cutting wit.
  
  Return only JSON like:
  {"summary":"...markdown...","quip":"...one liner..."}
  `.trim();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
          const result = await env.AI.run(model, {
            messages: [
              { role: "system", content: "You write clear, useful product summaries with dry humor when asked." },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 600,
            signal: controller.signal
          });
          clearTimeout(timeout);
          console.log('AI RUN RESULT:', JSON.stringify(result, null, 2));

          const raw = (result && typeof result === "object" && "response" in result)
            ? result.response
            : String(result || "");

          // Optional debug: set env.DEBUG="true" to log model output
          const DEBUG = String(env.DEBUG || "").toLowerCase() === "true";
          if (DEBUG) console.log("RAW_MODEL_OUTPUT:", raw);

          // Parse the JSON, tolerate messy outputs
          const parsed = safeJson(raw);
          let summary = cleanStr(parsed.summary || "");
          let quip = cleanStr(parsed.quip || "");

          // Fallbacks if the model did not give what we asked for
          if (!summary) {
            summary = fallbackSummary(a, n);
          }
          if (wants_quip && !quip) {
            quip = fallbackQuip(a, n);
          }
          if (!wants_quip) quip = "";

          return json({ summary, quip }, 200, request);
        } catch (e) {
          clearTimeout(timeout);
          if (e.name === 'AbortError') {
            console.log('AI request timed out');
            return json({
              summary: fallbackSummary(a, n),
              quip: wants_quip ? fallbackQuip(a, n) : ""
            }, 200, request);
          }
          console.error('Worker Error:', e);
          if (e.stack) console.error(e.stack);
          return json({ error: String(e) }, 400, request);
        }
      } catch (e) {
        console.error('Worker Error:', e);
        if (e.stack) console.error(e.stack);
        return json({ error: String(e) }, 400, request);
      }
    }
  };

  /* ---------------- helpers ---------------- */

  const PER_MIN_LIMIT = 30; // requests per IP per minute

  function clientIp(req) {
    return (
      req.headers.get("CF-Connecting-IP") ||
      req.headers.get("x-forwarded-for") ||
      "unknown"
    );
  }

  async function rateLimit(env, req) {
    // KV namespace binding: RL_KV
    const ip = clientIp(req);
    const bucket = `${ip}:${Math.floor(Date.now() / 60000)}`; // current minute
    const cur = parseInt((await env.RL_KV.get(bucket)) || "0", 10) + 1;

    if (cur === 1) {
      // first hit in this minute: set TTL so the key expires
      await env.RL_KV.put(bucket, String(cur), { expirationTtl: 65 });
    } else {
      await env.RL_KV.put(bucket, String(cur));
    }
    return cur <= PER_MIN_LIMIT;
  }

  // Simple mirror check utility for future list validation (unused now)
  function countLines(s) {
    return String(s).split(/\r?\n/).filter(Boolean).length;
  }

  function corsHeaders(req) {
    // Allowlisted origins
    const ALLOW = new Set([
      "https://xfory.vercel.app",
      "http://localhost:3000"
    ]);
    const origin = req.headers.get("Origin") || "";
    const allowOrigin = ALLOW.has(origin) ? origin : "https://xfory.vercel.app";

    // Reflect requested method/headers so preflight passes
    const reqHdrs = req.headers.get("Access-Control-Request-Headers") || "content-type";
    const reqMethod = req.headers.get("Access-Control-Request-Method") || "POST";

    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": `${reqMethod}, OPTIONS`,
      "Access-Control-Allow-Headers": reqHdrs,
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
      "Content-Type": "application/json"
    };
  }

  function json(data, status, req) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders(req) });
  }

  // Robust JSON extractor for messy LLM outputs
  function safeJson(s){
    const text = String(s || "").trim();

    // strip code fences if present
    const defenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    // try full parse
    try { return JSON.parse(defenced) } catch {}

    // try to extract the largest {...} block
    const start = defenced.indexOf("{");
    const end = defenced.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const slice = defenced.slice(start, end + 1);
      try { return JSON.parse(slice) } catch {}
    }

    // last resort: quick repairs
    try {
      const repaired = defenced
        .replace(/[\u2018\u2019]/g, "'")      // curly single → straight
        .replace(/[\u201C\u201D]/g, '"')      // curly double → straight
        .replace(/(['"])?summary\1\s*:/i, '"summary":')
        .replace(/(['"])?quip\1\s*:/i, '"quip":')
        .replace(/,(\s*[}\]])/g, "$1");       // trailing commas
      return JSON.parse(repaired);
    } catch {}

    return {};
  }

  function cleanStr(s) {
    return String(s || "").trim();
  }

  function fallbackQuip(a, n) {
    return `${a} for ${n}. What could possibly go wrong.`;
  }

  function fallbackSummary(a, n) {
    return `**Executive Summary:** ${a} for ${n} delivers a focused solution that adapts a proven interaction model to a new market. The product distills the original playbook into the core job to be done, cutting friction and aligning incentives for early adopters.

  **Business Model:**
  1. Subscription tiers for power users and teams with usage based limits.
  2. Marketplace or transaction fees on paid interactions.
  3. Partnerships that bundle onboarding, data, or compliance for enterprise pilots.`;
  }