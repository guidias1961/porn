// Orion Peep Show — backend com proxy anti-CORS, CSP e persistência
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "db.json");

// Explorer padrão. Pode sobrescrever com EXPLORER_BASE
const DEFAULT_EXPLORER_BASE = (process.env.EXPLORER_BASE || "https://scan.pulsechain.com/api/v2").replace(/\/$/, "");

// CSP: só permite XHR para o próprio domínio
app.use((req, res, next) => {
  res.set(
    "Content-Security-Policy",
    "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self';"
  );
  next();
});

// DB simples
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ items: {} }, null, 2));
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch { return { items: {} }; } }
function saveDB(state) { fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2)); }
let db = loadDB();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// Proxy anti-CORS
app.get("/api/explorer/addresses/:hash", async (req, res) => {
  const base = (req.query.base || DEFAULT_EXPLORER_BASE).replace(/\/$/, "");
  const hash = req.params.hash;
  const urls = [
    `${base}/addresses/${hash}`,
    `${base}/addresses/${hash}/`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "porn-orion-peep-show/1.0" },
        timeout: 10000
      });
      const text = await r.text();
      res.set("x-proxy-source", url);
      res.status(r.status).type("application/json").send(text);
      return;
    } catch (_) { /* tenta próxima */ }
  }
  res.status(502).json({ error: "proxy_fetch_failed", base, hash });
});

// Persistência para Trending
// body: { address, type: 'wallet'|'token', symbol, usd, balance, titleLine, message }
app.post("/api/record", (req, res) => {
  const { address, type, symbol, usd, balance, titleLine, message } = req.body || {};
  if (!address || !type) return res.status(400).json({ error: "missing address/type" });
  const k = String(address).toLowerCase();
  const prev = db.items[k] || { count: 0 };
  db.items[k] = {
    address: k,
    type,
    symbol: symbol || prev.symbol || null,
    usd: typeof usd === "number" ? usd : prev.usd || 0,
    balance: typeof balance === "number" ? balance : prev.balance || 0,
    titleLine: titleLine || prev.titleLine || "",
    message: message || prev.message || "",
    count: prev.count + 1,
    lastAt: Date.now()
  };
  saveDB(db);
  res.json({ ok: true, item: db.items[k] });
});

// Trending
app.get("/api/trending", (req, res) => {
  const limit = Number(req.query.limit || 12);
  const arr = Object.values(db.items);
  const wallets = arr.filter(i => i.type === "wallet").sort((a,b)=>b.count-a.count).slice(0, limit);
  const tokens  = arr.filter(i => i.type === "token").sort((a,b)=>b.count-a.count).slice(0, limit);
  res.json({ wallets, tokens, total: arr.length, updatedAt: Date.now() });
});

app.get("/", (_req, res) => res.sendFile(path.join(PUB, "index.html")));

app.listen(PORT, () => console.log("Orion Peep Show on " + PORT));

