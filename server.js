// SIGI web server
// - serves the app from /public
// - keeps recall data fresh: CPSC + FDA every 30 minutes, NHTSA live per vehicle
// - looks up barcodes, and runs Claude on the server so the API key stays secret
import express from "express";
import compression from "compression";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000,
  SUPABASE_URL = "",
  SUPABASE_ANON_KEY = "",
  ANTHROPIC_API_KEY = "",
  ANTHROPIC_MODEL = "claude-haiku-5-5",
  AMAZON_TAG = "",            // your Amazon Associates tracking ID, e.g. sigi-20
  REFRESH_MINUTES = "30",
} = process.env;

const UA = "SIGI recall checker (https://github.com/kendrybautista/sigi)";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render sits behind a proxy
app.use(compression({ filter: (req, res) => req.path !== "/data/data.json" && compression.filter(req, res) }));
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self)",
  });
  next();
});

// ---------------------------------------------------------------------------
// helpers
const getJson = async (url, ms = 8000) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
};
const getText = async (url, ms = 8000) => {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.text();
};
const clip = (s, n) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…";
};
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const clientIp = (req) => req.ip;

function limiter(perHour) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (seen.get(key) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= perHour) return false;
    recent.push(now);
    seen.set(key, recent);
    if (seen.size > 20000) seen.delete(seen.keys().next().value);
    return true;
  };
}

// barcodes written inside notice text, e.g. "UPC 0 41220 79476 4"
const UPC_NUM = /(?<!\d)\d(?:[ -]?\d){7,13}(?!\d)/g;
const UPC_CTX = /upc|gtin|barcode|bar code|ean/i;
function gtinOk(d) {
  if (![8, 12, 13, 14].includes(d.length)) return false;
  let t = 0;
  [...d.slice(0, -1)].reverse().forEach((c, i) => (t += +c * (i % 2 === 0 ? 3 : 1)));
  return (10 - (t % 10)) % 10 === +d.slice(-1);
}
function upcsIn(...texts) {
  const out = [];
  for (const text of texts.map((t) => String(t || ""))) {
    for (const m of text.matchAll(UPC_NUM)) {
      if (!UPC_CTX.test(text.slice(Math.max(0, m.index - 160), m.index))) continue;
      const d = m[0].replace(/\D/g, "");
      if (gtinOk(d) && !out.includes(d)) out.push(d);
    }
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------
// live recall data
// Starts from public/data/data.json (rebuilt weekly by GitHub Actions, includes
// child seats and the vehicle list), then merges in fresh CPSC and FDA records.
const DATA_FILE = path.join(__dirname, "public", "data", "data.json");
const LIVE = { data: null, body: null, gzip: null, etag: "", sources: {} };

function cpscRecord(r) {
  const prods = r.Products || [];
  const haz = (r.Hazards || []).map((h) => h.Name).filter((n) => n && !/None reported/i.test(n));
  const title = r.Title || "";
  const due = title.match(/Due to (.+)$/);
  return {
    id: "C" + r.RecallNumber, src: "cpsc", date: String(r.RecallDate || "").slice(0, 10),
    title: clip(title, 200),
    products: prods.slice(0, 4).map((p) => clip(p.Name, 90)).join("; "),
    model: clip(prods.slice(0, 4).map((p) => p.Model || "").join(" "), 160),
    type: prods[0]?.Type || "", units: prods[0]?.NumberOfUnits || "",
    hazard: clip(haz[0] || (due ? due[1] : ""), 200),
    remedy: clip(r.Remedies?.[0]?.Name, 240),
    desc: clip(r.Description, 260),
    sold: clip(r.Retailers?.[0]?.Name, 140),
    upc: [...new Set([
      ...(r.ProductUPCs || []).map((u) => String(u.UPC || "").replace(/\D/g, "")).filter(Boolean),
      ...upcsIn(r.Description, prods.map((p) => `${p.Description || ""} ${p.Model || ""}`).join(" ")),
    ])].slice(0, 20),
    img: r.Images?.[0]?.URL || "",
    url: r.URL || "",
  };
}
function fdaRecord(r) {
  const d = r.report_date || "";
  return {
    id: "F" + r.recall_number, src: "fda", date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    title: clip(`${r.recalling_firm}: ${r.product_description}`, 200),
    products: clip(r.product_description, 200), model: clip(r.code_info, 160),
    type: "Food", units: clip(r.product_quantity, 40), hazard: clip(r.reason_for_recall, 200),
    remedy: `Do not eat. Return to the store or throw it away. Status: ${r.status}.`,
    desc: "", sold: clip(r.distribution_pattern, 140),
    upc: upcsIn(r.product_description, r.code_info, r.more_code_info),
    url: "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
  };
}
// FDA company announcements (RSS) show up within hours, days before the weekly enforcement report
function rssRecords(xml) {
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
  const unescape = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const link = unescape(tag(it, "link")).trim().replace(/^http:/, "https:");
    const title = unescape(tag(it, "title")).trim();
    const when = new Date(unescape(tag(it, "pubDate")));
    const slug = link.split("/").filter(Boolean).pop() || title;
    return {
      id: "A" + slug.slice(0, 60), src: "alert", date: isNaN(when) ? ymd(new Date()) : ymd(when),
      title: clip(title, 200), products: clip(title.replace(/\s+(Issues|Announces|Recalls|Voluntarily).*/i, ""), 200),
      model: "", type: "FDA alert", units: "", hazard: clip(unescape(tag(it, "description")), 220),
      remedy: "Read the company announcement for lot codes, dates and what to do.",
      desc: "", sold: "", upc: [], url: link,
    };
  }).filter((r) => r.title && r.url);
}

async function fetchCpsc(days) {
  const rows = await getJson(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${ymd(daysAgo(days))}`, 60_000);
  return rows.map(cpscRecord);
}
async function fetchFda(days) {
  const out = [];
  for (let skip = 0; skip < 3000; skip += 1000) {
    const url = `https://api.fda.gov/food/enforcement.json?search=report_date:[${ymd(daysAgo(days)).replace(/-/g, "")}+TO+${ymd(new Date()).replace(/-/g, "")}]+AND+classification:%22Class+I%22&limit=1000&skip=${skip}`;
    const d = await getJson(url, 30_000);
    out.push(...(d.results || []).map(fdaRecord));
    if (out.length >= (d.meta?.results?.total || 0)) break;
  }
  return out;
}
async function fetchAlerts() {
  return rssRecords(await getText("https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml", 20_000));
}

function publish(data) {
  data.asOf = new Date().toISOString();
  data.sources = LIVE.sources;
  LIVE.data = data;
  LIVE.body = Buffer.from(JSON.stringify(data));
  LIVE.gzip = zlib.gzipSync(LIVE.body, { level: 6 });
  LIVE.etag = `"${data.asOf}"`;
}

async function refresh(full) {
  const base = LIVE.data || JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const byId = new Map(base.products.map((r) => [r.id, r]));
  const jobs = [
    ["cpsc", () => fetchCpsc(full ? 730 : 60)],
    ["fda", () => fetchFda(full ? 365 : 90)],
    ["alerts", fetchAlerts],
  ];
  let changed = 0;
  for (const [name, job] of jobs) {
    try {
      const rows = await job();
      for (const r of rows) {
        const old = byId.get(r.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(r)) changed++;
        byId.set(r.id, { ...old, ...r });
      }
      LIVE.sources[name] = { ok: true, at: new Date().toISOString(), count: rows.length };
    } catch (e) {
      LIVE.sources[name] = { ok: false, at: new Date().toISOString(), error: String(e.message || e) };
      console.error(`refresh ${name} failed:`, e.message || e);
    }
  }
  // company alerts duplicate the formal notice once it arrives; keep them 45 days
  const cutoff = ymd(daysAgo(731)), alertCutoff = ymd(daysAgo(45));
  const products = [...byId.values()]
    .filter((r) => r.src === "seat" || (r.src === "alert" ? r.date >= alertCutoff : r.date >= cutoff))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  publish({ ...base, products });
  console.log(`recall data refreshed (${full ? "full" : "quick"}): ${products.length} records, ${changed} new or changed`);
}

// serve the base file right away, then go live
try { publish(JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) { console.error("couldn't read data.json", e); }
let lastFull = 0;
const tick = async () => {
  const full = Date.now() - lastFull > 12 * 3600_000;
  try { await refresh(full); if (full) lastFull = Date.now(); } catch (e) { console.error("refresh failed", e); }
};
setTimeout(tick, 2000);
setInterval(tick, Math.max(5, +REFRESH_MINUTES) * 60_000);

app.get("/data/data.json", (req, res) => {
  if (!LIVE.body) return res.status(503).json({ error: "Recall data is loading. Try again in a moment." });
  res.set({ "Content-Type": "application/json", "Cache-Control": "no-cache", ETag: LIVE.etag, Vary: "Accept-Encoding" });
  if (req.get("if-none-match") === LIVE.etag) return res.status(304).end();
  if (/\bgzip\b/.test(req.get("accept-encoding") || "")) return res.set("Content-Encoding", "gzip").send(LIVE.gzip);
  res.send(LIVE.body);
});
app.get("/api/status", (req, res) => res.json({ asOf: LIVE.data?.asOf, records: LIVE.data?.products?.length, sources: LIVE.sources }));

// ---------------------------------------------------------------------------
// live vehicle recalls from NHTSA (cached 1 hour)
const carCache = new Map();
const carLimit = limiter(300);
app.get("/api/vehicle", async (req, res) => {
  const make = String(req.query.make || "").slice(0, 60), model = String(req.query.model || "").slice(0, 80), year = String(req.query.year || "").replace(/\D/g, "").slice(0, 4);
  if (!make || !model || year.length !== 4) return res.status(400).json({ error: "Pick a make, model and year." });
  if (!carLimit(clientIp(req))) return res.status(429).json({ error: "Too many lookups this hour." });
  const key = `${make}|${model}|${year}`.toUpperCase();
  const hit = carCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return res.json(hit.value);
  try {
    const d = await getJson(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`, 10_000);
    const yes = (v) => v === true || String(v).toLowerCase() === "true";
    const recalls = (d.results || []).map((r) => {
      const [dd, mm, yy] = String(r.ReportReceivedDate || "").split("/");
      return {
        id: r.NHTSACampaignNumber, d: yy ? `${yy}-${mm}-${dd}` : "", c: clip(String(r.Component || "").replace(/:/g, ": ").toLowerCase().replace(/(^|\s)\S/g, (s) => s.toUpperCase()), 60),
        s: clip(r.Summary, 230), q: clip(r.Consequence, 170), r: clip(r.Remedy, 150), n: yes(r.parkIt), o: yes(r.parkOutSide), ota: yes(r.overTheAirUpdate),
      };
    });
    const value = { live: true, at: new Date().toISOString(), recalls };
    carCache.set(key, { at: Date.now(), value });
    if (carCache.size > 3000) carCache.delete(carCache.keys().next().value);
    res.json(value);
  } catch (e) {
    res.status(502).json({ error: "NHTSA didn't answer. Showing saved data instead." });
  }
});

// ---------------------------------------------------------------------------
// barcode lookup: product name + picture, and FDA notices that print the barcode
const productCache = new Map();
const scanLimit = limiter(120);
const firstOk = async (tries) => {
  for (const t of tries) { try { const v = await t(); if (v) return v; } catch (e) { /* next source */ } }
  return null;
};
async function lookupProduct(code) {
  const variants = [...new Set([code, code.padStart(13, "0"), code.replace(/^0+/, "").padStart(12, "0")])];
  const facts = (host) => async () => {
    for (const c of variants) {
      const d = await getJson(`https://${host}/api/v2/product/${c}.json?fields=product_name,product_name_en,brands,categories,image_front_url,image_front_small_url,image_url`, 6000);
      const p = d?.product, name = p?.product_name_en || p?.product_name;
      if (d?.status === 1 && name) {
        return { name, brand: (p.brands || "").split(",")[0].trim(), category: (p.categories || "").split(",").pop().trim(),
          image: p.image_front_url || p.image_url || p.image_front_small_url || "", source: host.split(".")[1] };
      }
    }
    return null;
  };
  const upcItemDb = async () => {
    const d = await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, 6000);
    const it = d?.items?.[0];
    return it?.title ? { name: it.title, brand: it.brand || "", category: (it.category || "").split(">").pop().trim(),
      image: (it.images || []).find((u) => /^https:/.test(u)) || "", source: "upcitemdb" } : null;
  };
  return firstOk([facts("world.openfoodfacts.org"), facts("world.openproductsfacts.org"), upcItemDb]);
}
async function fdaByBarcode(code) {
  const core = code.replace(/^0+/, "");
  const q = encodeURIComponent(`product_description:"${core}" OR code_info:"${core}"`);
  try {
    const d = await getJson(`https://api.fda.gov/food/enforcement.json?search=${q}&limit=5`, 8000);
    return (d.results || []).map((r) => ({ ...fdaRecord(r), upc: [code] }));
  } catch (e) { return []; } // openFDA answers 404 when nothing matches
}
app.get("/api/product/:code", async (req, res) => {
  const code = String(req.params.code || "").replace(/\D/g, "");
  if (code.length < 8 || code.length > 14) return res.status(400).json({ error: "That doesn't look like a product barcode." });
  if (!scanLimit(clientIp(req))) return res.status(429).json({ error: "Too many scans this hour. Try again later." });
  const cached = productCache.get(code);
  if (cached && Date.now() - cached.at < 86_400_000) return res.json(cached.value);
  const [product, fda] = await Promise.all([lookupProduct(code), fdaByBarcode(code)]);
  const value = { code, product, fda };
  productCache.set(code, { at: Date.now(), value });
  if (productCache.size > 5000) productCache.delete(productCache.keys().next().value);
  res.set("Cache-Control", "private, max-age=3600").json(value);
});

// ---------------------------------------------------------------------------
// Claude (signed-in users only, so strangers can't spend your API credit)
const aiLimit = limiter(40);
async function supabaseUser(token) {
  if (!token || !SUPABASE_URL) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(6000) });
  return r.ok ? r.json() : null;
}
async function claude(prompt, maxTokens = 900) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: maxTokens,
      system: "You are SIGI's product-safety assistant. You only help with consumer products, recalls and safer alternatives. Never invent recall facts. Reply with JSON only, no other text.",
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
async function aiGate(req, res) {
  if (!ANTHROPIC_API_KEY) { res.status(503).json({ error: "Claude is turned off on this server." }); return false; }
  const user = await supabaseUser((req.get("authorization") || "").replace(/^Bearer\s+/i, "")).catch(() => null);
  if (!user?.id) { res.status(401).json({ error: "Sign in to use Claude features." }); return false; }
  if (!aiLimit(user.id)) { res.status(429).json({ error: "Too many Claude requests this hour. Try again later." }); return false; }
  return true;
}
// general endpoint: the app sends the task; the server adds the safety rules
app.post("/api/ai", async (req, res) => {
  if (!(await aiGate(req, res))) return;
  const prompt = String(req.body?.prompt || "").slice(0, 6000);
  if (!prompt.trim()) return res.status(400).json({ error: "Nothing to ask." });
  try { res.json(await claude(prompt)); }
  catch (e) { console.error("ai failed", e.message); res.status(502).json({ error: "Claude couldn't finish that. Try again in a moment." }); }
});
// kept for older versions of the app
app.post("/api/compare", async (req, res) => {
  if (!(await aiGate(req, res))) return;
  const { query, candidates } = req.body || {};
  if (typeof query !== "string" || !Array.isArray(candidates) || !candidates.length) return res.status(400).json({ error: "Missing query or candidates." });
  const prompt = `A shopper typed: "${query.slice(0, 200)}". Candidate recall notices (JSON): ${JSON.stringify(candidates.slice(0, 8)).slice(0, 4000)}
For each, judge SAME product, MAYBE, or DIFFERENT. Be strict. Return {"verdict":"skip"|"check"|"get","summary":"one or two plain sentences, including what to look for on the label","matches":[{"id":"...","fit":"same"|"maybe"|"different","reason":"short"}]}`;
  try { res.json(await claude(prompt, 800)); }
  catch (e) { res.status(502).json({ error: "Claude couldn't finish that check. Try again in a moment." }); }
});

// ---------------------------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    compareEnabled: Boolean(ANTHROPIC_API_KEY),
    aiEnabled: Boolean(ANTHROPIC_API_KEY),
    amazonTag: AMAZON_TAG,
    refreshMinutes: +REFRESH_MINUTES,
  });
});
app.get("/healthz", (req, res) => res.send("ok"));

app.use("/data", express.static(path.join(__dirname, "public", "data"), { maxAge: "1h" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "10m", index: "index.html" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`SIGI running on http://localhost:${PORT}`));
