/* Blossoms — cloud sync service (Cloud Run + Firestore + Cloud Storage)
 *
 * Local-first design: the phone stays the fast copy. This service is the
 * durable one. Every change is pushed here; on open the app pulls anything
 * newer. Merge is last-write-wins per ORDER (not per field), using the
 * order's own updatedAt, so two devices never corrupt each other — the
 * worst case is one device's edit of a single order losing to a newer one.
 *
 * Env:
 *   SYNC_TOKEN   required — shared secret the app sends as Bearer
 *   BUCKET       required — Cloud Storage bucket for photos
 *   GOOGLE_CLOUD_PROJECT / PORT  provided by Cloud Run
 */
"use strict";

const express = require("express");
const { Firestore } = require("@google-cloud/firestore");
const { Storage } = require("@google-cloud/storage");

const PORT = process.env.PORT || 8080;
const TOKEN = (process.env.SYNC_TOKEN || "").trim();
const BUCKET = (process.env.BUCKET || "").trim();

if (!TOKEN) console.error("FATAL: SYNC_TOKEN not set");
if (!BUCKET) console.error("FATAL: BUCKET not set");

const db = new Firestore();               // uses the (default) database — the free-tier one
const storage = new Storage();
const bucket = () => storage.bucket(BUCKET);
const ORDERS = db.collection("orders");

const app = express();
app.disable("x-powered-by");
// orders are small; photos come through as base64 so allow a generous body
app.use(express.json({ limit: "12mb" }));

/* ---- CORS: the app is served from GitHub Pages, a different origin ---- */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");           // guarded by the bearer token, not by origin
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/* ---- auth ----
   Two credentials are accepted: the long token (used by the one-tap setup link)
   and a SHORT code Michele can actually type off a note. The short code is only
   safe because failures are throttled hard, so brute force isn't viable. */
const SHORT = (process.env.SHORT_CODE || "").trim();

const fails = new Map();
const FAIL_LIMIT = 10, FAIL_WINDOW = 15 * 60000;
function throttled(ip) {
  const r = fails.get(ip);
  if (!r) return false;
  if (Date.now() > r.until) { fails.delete(ip); return false; }
  return r.count >= FAIL_LIMIT;
}
function noteFail(ip) {
  const r = fails.get(ip) || { count: 0, until: 0 };
  r.count++; r.until = Date.now() + FAIL_WINDOW;
  fails.set(ip, r);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of fails) if (now > r.until) fails.delete(ip);
}, 10 * 60000).unref();

function sameSecret(a, b) {
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(req, res, next) {
  if (!TOKEN || !BUCKET) return res.status(503).json({ error: "not configured" });
  const ip = (req.get("x-forwarded-for") || "").split(",")[0].trim() || req.ip || "?";
  if (throttled(ip)) return res.status(429).json({ error: "too many attempts, wait 15 minutes" });

  const h = req.get("authorization") || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  const ok = sameSecret(got, TOKEN) || (SHORT && sameSecret(got, SHORT));
  if (!ok) { noteFail(ip); return res.status(401).json({ error: "unauthorized" }); }
  fails.delete(ip);
  next();
}

/* ---- PULL: everything changed since a timestamp ---- */
app.get("/api/orders", authed, async (req, res) => {
  try {
    const since = req.query.since || "";
    let q = ORDERS;
    if (since) q = q.where("updatedAt", ">", String(since));
    const snap = await q.get();
    const orders = snap.docs.map(d => d.data());
    // awaited BEFORE the response on purpose: Cloud Run throttles CPU once the response
    // is sent, so fire-and-forget background work stalls. Self-throttled to once per 6h,
    // so only one pull per 6h pays the ~2s — a snapshot lands just from opening the app.
    await maybeSnapshot();
    res.json({ orders, serverTime: new Date().toISOString() });
  } catch (e) {
    console.error("pull failed", e);
    res.status(500).json({ error: "pull failed" });
  }
});

/* ---- automatic snapshots ----
   The app's credential ships inside a public web page, so anyone who digs it out
   could in principle wipe the book. Snapshots make that recoverable — and far more
   usefully, they also cover Michele deleting something by accident and noticing
   weeks later, which Firestore's 7-day PITR would not.
   Taken at most once every 6h. 90 kept (~3 weeks of rolling history). */
let lastSnapAt = 0;
const SNAP_EVERY_MS = 6 * 3600 * 1000;
async function maybeSnapshot() {
  if (Date.now() - lastSnapAt < SNAP_EVERY_MS) return;
  lastSnapAt = Date.now();
  try {
    const snap = await ORDERS.get();
    const all = snap.docs.map(d => d.data());
    const name = "snapshots/" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    await bucket().file(name).save(JSON.stringify({ takenAt: new Date().toISOString(), orders: all }), {
      contentType: "application/json", resumable: false
    });
    // prune to the most recent 90
    const [files] = await bucket().getFiles({ prefix: "snapshots/" });
    const old = files.sort((a, b) => a.name < b.name ? 1 : -1).slice(90);
    for (const f of old) { try { await f.delete(); } catch (e) { } }
    console.log("snapshot written", name, all.length, "orders");
  } catch (e) {
    console.error("snapshot failed", e);   // never block a save on this
  }
}

/* ---- PUSH: upsert a batch, newest-wins ---- */
app.post("/api/orders", authed, async (req, res) => {
  const incoming = Array.isArray(req.body && req.body.orders) ? req.body.orders : null;
  if (!incoming) return res.status(400).json({ error: "expected {orders:[...]}" });
  if (incoming.length > 500) return res.status(413).json({ error: "too many orders in one push" });
  try {
    const written = [];
    // read-then-write per order so an older device can't clobber a newer edit
    for (const o of incoming) {
      if (!o || typeof o.id !== "string" || !o.id) continue;
      const ref = ORDERS.doc(o.id);
      await db.runTransaction(async tx => {
        const cur = await tx.get(ref);
        if (cur.exists) {
          const mine = String(o.updatedAt || "");
          const theirs = String((cur.data() || {}).updatedAt || "");
          if (mine <= theirs) return;          // server copy is newer — keep it
        }
        tx.set(ref, o);
        written.push(o.id);
      });
    }
    if (written.length) await maybeSnapshot();   // awaited pre-response (Cloud Run CPU-throttle) — a separate GCS copy, independent of Firestore
    res.json({ ok: true, written: written.length, serverTime: new Date().toISOString() });
  } catch (e) {
    console.error("push failed", e);
    res.status(500).json({ error: "push failed" });
  }
});

/* ---- PHOTOS ---- */
// upload: {id, dataUrl} -> stored once, keyed by the app's content hash
app.post("/api/photo", authed, async (req, res) => {
  const { id, dataUrl } = req.body || {};
  if (!id || typeof id !== "string" || !/^[a-f0-9]{16,80}$/i.test(id)) {
    return res.status(400).json({ error: "bad photo id" });
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return res.status(400).json({ error: "bad image" });
  }
  try {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(5, comma);                 // e.g. image/webp;base64
    const contentType = meta.split(";")[0] || "image/jpeg";
    const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: "photo too large" });
    const file = bucket().file("photos/" + id);
    const [exists] = await file.exists();
    if (!exists) await file.save(buf, { contentType, resumable: false });
    res.json({ ok: true, id });
  } catch (e) {
    console.error("photo upload failed", e);
    res.status(500).json({ error: "upload failed" });
  }
});

// download: streamed back through the service so the bucket stays private
app.get("/api/photo/:id", authed, async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{16,80}$/i.test(id)) return res.status(400).end();
  try {
    const file = bucket().file("photos/" + id);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).end();
    const [meta] = await file.getMetadata();
    res.set("Content-Type", meta.contentType || "image/jpeg");
    res.set("Cache-Control", "private, max-age=31536000, immutable"); // content-hashed, so safe forever
    file.createReadStream().on("error", () => res.status(500).end()).pipe(res);
  } catch (e) {
    console.error("photo fetch failed", e);
    res.status(500).end();
  }
});

// which photo ids does the cloud already have? lets the app skip re-uploading
app.post("/api/photo/missing", authed, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 500) : [];
  try {
    const missing = [];
    for (const id of ids) {
      if (!/^[a-f0-9]{16,80}$/i.test(id)) continue;
      const [exists] = await bucket().file("photos/" + id).exists();
      if (!exists) missing.push(id);
    }
    res.json({ missing });
  } catch (e) {
    console.error("missing check failed", e);
    res.status(500).json({ error: "check failed" });
  }
});

app.listen(PORT, () => console.log("blossoms-sync listening on " + PORT));
