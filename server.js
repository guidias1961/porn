// Orion Peep Show — API mínima com persistência em arquivo
// Executa: node server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = path.join(__dirname, "db.json");

// helpers de persistência
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { items: {} }; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { console.error("DB write error:", e.message); }
}

let db = loadDB();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// grava uma análise
// body: { address, type: 'wallet'|'token', symbol, usd, balance, titleLine, message }
app.post("/api/record", (req, res) => {
  const { address, type, symbol, usd, balance, titleLine, message } = req.body || {};
  if (!address || !type) return res.status(400).json({ error: "missing address/type" });
  const k = address.toLowerCase();
  const now = Date.now();

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
    lastAt: now
  };
  saveDB(db);
  res.json({ ok: true, item: db.items[k] });
});

// trending: retorna top wallets e tokens
app.get("/api/trending", (req, res) => {
  const limit = Number(req.query.limit || 12);
  const items = Object.values(db.items);
  const wallets = items.filter(i => i.type === "wallet")
                       .sort((a,b)=>b.count-a.count).slice(0, limit);
  const tokens  = items.filter(i => i.type === "token")
                       .sort((a,b)=>b.count-a.count).slice(0, limit);
  res.json({ wallets, tokens, total: items.length, updatedAt: Date.now() });
});

app.listen(PORT, () => {
  console.log("Orion Peep Show on " + PORT);
});

