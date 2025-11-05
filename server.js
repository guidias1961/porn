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

// Bases corretas para o Pulse Blockscout
const V2_BASE = (process.env.EXPLORER_V2 || "https://api.scan.pulsechain.com/api/v2").replace(/\/$/, "");
const ES_BASE = (process.env.EXPLORER_ES || "https://api.scan.pulsechain.com/api").replace(/\/$/, "");

// CSP travando conexões externas no front
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
function loadDB(){ try{ return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }catch{ return { items: {} }; } }
function saveDB(state){ fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2)); }
let db = loadDB();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/**
 * Proxy anti CORS
 * 1 tenta Blockscout v2
 * 2 se 404 ou falha, cai na API estilo Etherscan e normaliza
 */
app.get("/api/explorer/addresses/:hash", async (req, res) => {
  const hash = req.params.hash;

  // 1 v2 direto
  try{
    const url = `${V2_BASE}/addresses/${hash}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, timeout: 10000 });
    const txt = await r.text();
    res.set("x-proxy-source", url);
    res.status(r.status).type("application/json").send(txt);
    if (r.ok) return; // só sai se 200
    // se 404 ou outro erro, cai no fallback
  }catch(_){ /* segue para fallback */ }

  // 2 fallback Etherscan-like balance + is_contract
  try{
    const balUrl = `${ES_BASE}?module=account&action=balance&address=${hash}`;
    const codeUrl = `${ES_BASE}?module=contract&action=getsourcecode&address=${hash}`;

    const [balR, codeR] = await Promise.all([
      fetch(balUrl, { headers: { accept: "application/json" }, timeout: 10000 }),
      fetch(codeUrl, { headers: { accept: "application/json" }, timeout: 10000 })
    ]);

    const balJ = await balR.json().catch(()=>({}));
    const codeJ = await codeR.json().catch(()=>({}));

    const balanceWei = balJ?.result || "0";
    const isContract = Array.isArray(codeJ?.result) && codeJ.result.length > 0 && codeJ.result[0]?.ContractName && codeJ.result[0].ContractName !== "";

    const normalized = {
      exchange_rate: null,
      items: [{
        hash,
        is_contract: !!isContract,
        coin_balance: balanceWei,       // wei string
        transactions_count: null,
        token: null,
        is_verified: null,
        reputation: "ok"
      }],
      next_page_params: null,
      _fallback: "etherscan_compat",
      _sources: { balance: balUrl, code: codeUrl }
    };

    res.set("x-proxy-source", "fallback");
    res.status(200).json(normalized);
  }catch(e){
    res.status(502).json({ error: "proxy_fallback_failed", details: String(e) });
  }
});

// Persistência Trending
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

app.get("/api/trending", (req, res) => {
  const limit = Number(req.query.limit || 12);
  const arr = Object.values(db.items);
  const wallets = arr.filter(i => i.type === "wallet").sort((a,b)=>b.count-a.count).slice(0, limit);
  const tokens  = arr.filter(i => i.type === "token").sort((a,b)=>b.count-a.count).slice(0, limit);
  res.json({ wallets, tokens, total: arr.length, updatedAt: Date.now() });
});

app.get("/", (_req, res) => res.sendFile(path.join(PUB, "index.html")));

app.listen(PORT, () => console.log("Orion Peep Show on " + PORT));

