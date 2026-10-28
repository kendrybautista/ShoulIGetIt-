// SIGI web server: serves the app from /public and keeps the Claude API key on the server.
import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000,
  SUPABASE_URL = "",
  SUPABASE_ANON_KEY = "",
  ANTHROPIC_API_KEY = "",
  ANTHROPIC_MODEL = "claude-haiku-5-5",
} = process.env;

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "64kb" }));

// Basic security headers
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  });
  next();
});

// Public config for the browser. The Supabase anon key is meant to be public;
// row-level security in Supabase keeps each person's data private.
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    compareEnabled: Boolean(ANTHROPIC_API_KEY),
  });
});

app.get("/healthz", (req, res) => res.send("ok"));

// --- "Ask Claude to compare" -------------------------------------------------
// Only signed-in users may call it, so strangers can't spend your API credit.
const hits = new Map(); // userId -> timestamps in the last hour
const LIMIT_PER_HOUR = 30;

async function supabaseUser(token) {
  if (!token || !SUPABASE_URL) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  return r.ok ? r.json() : null;
}

app.post("/api/compare", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "Compare is turned off on this server." });

  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await supabaseUser(token).catch(() => null);
  if (!user?.id) return res.status(401).json({ error: "Sign in to use Ask Claude." });

  const now = Date.now();
  const recent = (hits.get(user.id) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= LIMIT_PER_HOUR) return res.status(429).json({ error: "Too many checks this hour. Try again later." });
  recent.push(now);
  hits.set(user.id, recent);

  const { query, candidates } = req.body || {};
  if (typeof query !== "string" || !query.trim() || !Array.isArray(candidates) || !candidates.length) {
    return res.status(400).json({ error: "Missing query or candidates." });
  }
  const cands = candidates.slice(0, 8).map((c) => ({
    id: String(c.id ?? "").slice(0, 40),
    title: String(c.title ?? "").slice(0, 240),
    products: String(c.products ?? "").slice(0, 240),
    models_or_lots: String(c.models_or_lots ?? "").slice(0, 200),
    type: String(c.type ?? "").slice(0, 60),
    date: String(c.date ?? "").slice(0, 10),
  }));

  const prompt = `You help a shopper decide whether a product they are about to buy is covered by a recall. They typed: "${query.slice(0, 200)}".
Candidate recall notices found by keyword search (JSON):
${JSON.stringify(cands)}
For each candidate, judge whether it is the SAME product the shopper means, MAYBE (same brand or product line but model, size or lot unclear), or DIFFERENT. Be strict: a shared generic word is not a match. Do not invent recalls beyond this list.
Return JSON only, no other text: {"verdict":"skip"|"check"|"get","summary":"one or two plain sentences for the shopper, including exactly what to look for on the box or label (model number, lot code, date) if relevant","matches":[{"id":"...","fit":"same"|"maybe"|"different","reason":"short"}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Anthropic API error", r.status, data?.error?.message);
      return res.status(502).json({ error: "Claude couldn't finish that check. Try again in a moment." });
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    res.json(json);
  } catch (e) {
    console.error("compare failed", e);
    res.status(502).json({ error: "Claude couldn't finish that check. Try again in a moment." });
  }
});

// --- static app --------------------------------------------------------------
app.use(
  "/data",
  express.static(path.join(__dirname, "public", "data"), { maxAge: "1h" })
);
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: "index.html" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`SIGI running on http://localhost:${PORT}`));
