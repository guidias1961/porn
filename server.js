// Orion Peep Show — proxy anti-CORS, detecção wallet/token, preço WPLS, Dexscreener, persistência de Trending + Feed
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

const V2_BASE = (process.env.EXPLORER_V2 || "https://api.scan.pulsechain.com/api/v2").replace(/\/$/, "");
const ES_BASE = (process.env.EXPLORER_ES || "https://api.scan.pulsechain.com/api").replace(/\/$/, "");

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

if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ items: {}, feed: [] }, null, 2));
const loadDB = () => {
  try {
    const j = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!j.items) j.items = {};
    if (!Array.isArray(j.feed)) j.feed = [];
    return j;
  } catch { return { items: {}, feed: [] }; }
};
const saveDB = (state) => fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
let db = loadDB();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// utils
async function getJSON(url){
  const r = await fetch(url, { headers: { accept: "application/json" }, timeout: 12000 });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { ok: r.ok, status: r.status, body, text, url };
}
function looksErc20Abi(abiStr){
  try{
    const abi = JSON.parse(abiStr);
    if (!Array.isArray(abi)) return false;
    const names = new Set(abi.filter(x=>x && x.name).map(x=>x.name));
    return names.has("totalSupply") && names.has("balanceOf") && names.has("transfer");
  }catch{ return false; }
}
function normalizeTokenFromV2(j, hash){
  const t = j?.token || j || {};
  return {
    kind: "token",
    exchange_rate: null,
    items: [{
      hash,
      is_contract: true,
      is_token: true,
      coin_balance: null,
      transactions_count: Number(t.transactions_count ?? 0),
      token: {
        symbol: t.symbol || null,
        name: t.name || null,
        address_hash: hash,
        decimals: Number(t.decimals ?? t.decimal ?? 18),
        holders_count: Number(t.holders_count ?? 0) || null,
        total_supply: String(t.total_supply ?? t.totalSupply ?? "0"),
        type: t.type || "ERC-20",
        icon_url: t.icon_url || t.icon || null,
        exchange_rate: t.exchange_rate || null,
        reputation: "ok",
        market: null
      },
      is_verified: !!(t.verified || t.is_verified),
      reputation: "ok"
    }]
  };
}
function normalizeWalletFromV2(j, hash){
  const it = Array.isArray(j?.items) ? (j.items[0] || {}) : (j || {});
  return {
    kind: "wallet",
    exchange_rate: j?.exchange_rate ?? null,
    items: [{
      hash,
      is_contract: !!it.is_contract,
      is_token: false,
      coin_balance: String(it.coin_balance ?? "0"),
      transactions_count: Number(it.transactions_count ?? 0),
      token: null,
      is_verified: !!it.is_verified,
      reputation: it.reputation || "ok"
    }]
  };
}
function normalizeWalletFromES(balanceWei, isContract, hash){
  return {
    kind: "wallet",
    exchange_rate: null,
    items: [{
      hash,
      is_contract: !!isContract,
      is_token: false,
      coin_balance: String(balanceWei || "0"),
      transactions_count: null,
      token: null,
      is_verified: null,
      reputation: "ok"
    }]
  };
}
function normalizeTokenFromES(hash, name, symbol){
  return {
    kind: "token",
    exchange_rate: null,
    items: [{
      hash,
      is_contract: true,
      is_token: true,
      coin_balance: null,
      transactions_count: null,
      token: {
        symbol: symbol || null,
        name: name || null,
        address_hash: hash,
        decimals: 18,
        holders_count: null,
        total_supply: "0",
        type: "ERC-20",
        icon_url: null,
        exchange_rate: null,
        reputation: "ok",
        market: null
      },
      is_verified: null,
      reputation: "ok"
    }]
  };
}

// Dexscreener
function pickBestPair(pairs){
  if(!Array.isArray(pairs) || !pairs.length) return null;
  const pulsePairs = pairs.filter(p => (p.chainId||"").toLowerCase().includes("pulse"));
  const list = pulsePairs.length ? pulsePairs : pairs;
  return list
    .map(p => ({ p, liq: Number(p?.liquidity?.usd||0) }))
    .sort((a,b) => b.liq - a.liq)[0]?.p || null;
}
async function enrichWithDexscreener(norm, addr){
  try{
    const ds = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const best = pickBestPair(ds.body?.pairs || []);
    if(!best) return norm;
    const mkt = {
      price_usd: best.priceUsd ? Number(best.priceUsd) : null,
      liquidity_usd: best.liquidity?.usd ? Number(best.liquidity.usd) : null,
      fdv_usd: best.fdv ? Number(best.fdv) : null,
      market_cap_usd: best.marketCap ? Number(best.marketCap) : (best.fdv ? Number(best.fdv) : null),
      pair_url: best.url || null,
      dex: best.dexId || null,
      base_symbol: best.baseToken?.symbol || null,
      base_name: best.baseToken?.name || null
    };
    const item = norm.items[0];
    if(item && item.token){
      item.token.market = mkt;
      if(!item.token.symbol && mkt.base_symbol) item.token.symbol = mkt.base_symbol;
      if(!item.token.name && mkt.base_name) item.token.name = mkt.base_name;
    }
  }catch{}
  return norm;
}

// preço WPLS
let priceCache = { val: null, ts: 0, src: "fallback" };
async function fetchWplsPrice(){
  if (process.env.WPLS_PRICE_USD) {
    const v = Number(process.env.WPLS_PRICE_USD);
    if (isFinite(v) && v > 0) return { price: v, src: "env" };
  }
  try{
    const r = await getJSON("https://api.dexscreener.com/latest/dex/search?q=wpls");
    const pairs = r.body?.pairs || [];
    const p = pairs.find(p => p?.baseToken?.symbol === "WPLS" && p?.priceUsd);
    if (p && Number(p.priceUsd) > 0) return { price: Number(p.priceUsd), src: "dexscreener" };
  }catch{}
  return { price: 0.00002, src: "fallback" };
}
app.get("/api/price", async (_req, res) => {
  const now = Date.now();
  if (priceCache.val && now - priceCache.ts < 60_000) {
    return res.json({ wplsUsd: priceCache.val, from: priceCache.src, cached: true });
  }
  const { price, src } = await fetchWplsPrice();
  priceCache = { val: price, ts: now, src };
  res.json({ wplsUsd: price, from: src, cached: false });
});

// classificação + enrich
app.get("/api/explorer/addresses/:hash", async (req, res) => {
  const hash = req.params.hash;

  try{
    const tok = await getJSON(`${V2_BASE}/tokens/${hash}`);
    if (tok.ok && tok.body) {
      let norm = normalizeTokenFromV2(tok.body, hash);
      norm = await enrichWithDexscreener(norm, hash);
      res.set("x-proxy-source", tok.url);
      return res.status(200).json(norm);
    }
  }catch{}

  try{
    const addr = await getJSON(`${V2_BASE}/addresses/${hash}`);
    if (addr.ok && addr.body) {
      let norm = normalizeWalletFromV2(addr.body, hash);
      if (norm.items[0].is_contract) {
        try{
          const tok2 = await getJSON(`${V2_BASE}/tokens/${hash}/`);
          if (tok2.ok && tok2.body) {
            let normTok = normalizeTokenFromV2(tok2.body, hash);
            normTok = await enrichWithDexscreener(normTok, hash);
            res.set("x-proxy-source", tok2.url);
            return res.status(200).json(normTok);
          }
        }catch{}
      }
      res.set("x-proxy-source", addr.url);
      return res.status(200).json(norm);
    }
  }catch{}

  try{
    const balUrl = `${ES_BASE}?module=account&action=balance&address=${hash}`;
    const abiUrl = `${ES_BASE}?module=contract&action=getabi&address=${hash}`;
    const srcUrl = `${ES_BASE}?module=contract&action=getsourcecode&address=${hash}`;
    const [balR, abiR, srcR] = await Promise.all([ getJSON(balUrl), getJSON(abiUrl), getJSON(srcUrl) ]);

    const balanceWei = balR?.body?.result ?? "0";
    const abiStr = abiR?.body?.result ?? "";
    const isContract = !!abiStr && abiStr !== "Contract source code not verified";

    if (isContract && looksErc20Abi(abiStr)) {
      const row = Array.isArray(srcR?.body?.result) ? srcR.body.result[0] : null;
      const name = row?.TokenName || null;
      const symbol = row?.TokenSymbol || null;
      let normTok = normalizeTokenFromES(hash, name, symbol);
      normTok = await enrichWithDexscreener(normTok, hash);
      res.set("x-proxy-source", "fallback:abi_erc20");
      return res.status(200).json(normTok);
    }
    const normWal = normalizeWalletFromES(balanceWei, isContract, hash);
    res.set("x-proxy-source", "fallback:wallet_balance");
    return res.status(200).json(normWal);
  }catch(e){
    return res.status(502).json({ error: "proxy_failed_all", details: String(e) });
  }
});

// persistência (Trending + Feed)
const FEED_MAX = 200;
app.post("/api/record", (req, res) => {
  const { address, type, symbol, name, usd, balance, titleLine, message, icon, holders, market } = req.body || {};
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

  // grava feed (remove duplicata antiga do mesmo address, mantém ordem por recência)
  db.feed = db.feed.filter(x => x.address !== k);
  db.feed.unshift({
    ts: Date.now(),
    address: k,
    type,
    symbol: symbol || null,
    name: name || null,
    usd: typeof usd === "number" ? usd : 0,
    balance: typeof balance === "number" ? balance : 0,
    titleLine: titleLine || "",
    message: message || "",
    icon: icon || null,
    holders: typeof holders === "number" ? holders : null,
    market: market || null
  });
  if (db.feed.length > FEED_MAX) db.feed.length = FEED_MAX;

  saveDB(db);
  res.json({ ok: true, item: db.items[k] });
});

// feed persistente
app.get("/api/feed", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 24), 100);
  res.json({ items: db.feed.slice(0, limit), updatedAt: Date.now() });
});

// trending
app.get("/api/trending", (req, res) => {
  const limit = Number(req.query.limit || 12);
  const arr = Object.values(db.items);
  const wallets = arr.filter(i => i.type === "wallet").sort((a,b)=>b.count-a.count).slice(0, limit);
  const tokens  = arr.filter(i => i.type === "token").sort((a,b)=>b.count-a.count).slice(0, limit);
  res.json({ wallets, tokens, total: arr.length, updatedAt: Date.now() });
});

app.get("/", (_req, res) => res.sendFile(path.join(PUB, "index.html")));
app.listen(PORT, () => console.log("Orion Peep Show on " + PORT));

