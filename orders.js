/* =========================================================================
   Blossoms by Michele — Orders
   A tiny order book for a baker who is terrified of forgetting an order.
   Order text lives in localStorage; photos live in IndexedDB.
   ========================================================================= */
(function () {
  "use strict";

  /* ================= constants ================= */
  var K_ORDERS = "blossoms.orders.v1";
  var K_DRAFT = "blossoms.draft.v1";
  var K_SNAP = "blossoms.snap.v1";
  var PHOTO_CAP = 6;
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var DOWFULL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var SOURCES = [
    { v: "instagram", label: "📷 Instagram" },
    { v: "text", label: "💬 Text" },
    { v: "email", label: "✉️ Email" },
    { v: "phone", label: "☎️ Phone" }
  ];
  var SRC_GLYPH = { instagram: "📷", text: "💬", email: "✉️", phone: "☎️", other: "" };
  var METHODS = [
    { v: "zelle", label: "Zelle" }, { v: "venmo", label: "Venmo" },
    { v: "cash", label: "Cash" }, { v: "check", label: "Check" }, { v: "card", label: "Credit card" }
  ];

  /* ================= tiny utils ================= */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function nowISO() { return new Date().toISOString(); }
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  }
  // "2026-08-26" -> local Date (avoid UTC parsing shift)
  function dateOf(iso) { if (!iso) return null; var p = iso.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function monthKey(iso) { return iso ? iso.slice(0, 7) : ""; }
  function monthLabel(mk) { var p = mk.split("-"); return MONTHS[+p[1] - 1] + " " + p[0]; }
  function fmtLong(iso) { var d = dateOf(iso); if (!d) return ""; return DOWFULL[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate(); }
  function fmtShort(iso) { var d = dateOf(iso); if (!d) return ""; return MONTHS[d.getMonth()].slice(0, 3) + " " + d.getDate(); }
  function fmtShortYear(iso) { var d = dateOf(iso); if (!d) return ""; return MONTHS[d.getMonth()].slice(0, 3) + " " + d.getDate() + ", " + d.getFullYear(); }
  function fmtTime(t) {
    if (!t) return "";
    var p = t.split(":"), h = +p[0], m = p[1];
    var ap = h >= 12 ? "PM" : "AM"; h = h % 12; if (h === 0) h = 12;
    return h + ":" + m + " " + ap;
  }
  function money(cents) {
    if (cents == null) return "";
    var neg = cents < 0; cents = Math.abs(cents);
    var d = cents / 100, hasCents = cents % 100 !== 0;
    return (neg ? "-$" : "$") + d.toLocaleString("en-US", { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 });
  }
  function parseMoney(str) {
    if (str == null) return null;
    var s = String(str).replace(/[^0-9.]/g, "");
    if (s === "") return null;
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return Math.round(n * 100);
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }

  /* ================= store ================= */
  var DB = { v: 1, orders: [], meta: { lastBackupAt: null, changesSinceBackup: 0, everHadOrders: false, snoozeUntil: null } };

  function load() {
    try {
      var raw = localStorage.getItem(K_ORDERS);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && Array.isArray(p.orders)) {
          DB = p;
          DB.meta = DB.meta || {};
          if (DB.meta.changesSinceBackup == null) DB.meta.changesSinceBackup = 0;
        }
      }
    } catch (e) { console.error("load failed", e); }
  }
  function persist(countChange) {
    if (countChange !== false) DB.meta.changesSinceBackup = (DB.meta.changesSinceBackup || 0) + 1;
    if (DB.orders.some(function (o) { return !o.deletedAt; })) DB.meta.everHadOrders = true;
    var json = JSON.stringify(DB);
    var ok = true;
    try {
      localStorage.setItem(K_ORDERS, json);
    } catch (e) {
      console.error("save failed", e);
      ok = false;
    }
    mirror(json); // second copy + restore point, always — even if localStorage just failed
    if (!ok) alert("Your phone is low on space. Your order was copied to the backup store, but please tap SAVE MY ORDERS now.");
    return ok;
  }
  function snapshot() {
    try {
      var arr = JSON.parse(localStorage.getItem(K_SNAP) || "[]");
      arr.unshift(localStorage.getItem(K_ORDERS) || "");
      localStorage.setItem(K_SNAP, JSON.stringify(arr.slice(0, 3)));
    } catch (e) { /* snapshots are best-effort */ }
  }
  function blank() {
    return {
      id: uuid(), v: 1, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null,
      eventDate: todayISO(), eventTime: "", dateConfirmed: true, altDateNote: "",
      name: "", source: "instagram", handle: "", phone: "", email: "",
      what: "", avoid: "", aboutThem: "", cardMessage: "",
      photos: [], photoError: false,
      totalCents: null, totalInferred: false, totalHistory: [],
      deliveryFeeCents: null, deliveryTBD: false, noDepositNeeded: false,
      payments: [], fulfillment: "", address: "",
      kind: "order", tentative: false, done: false, doneAt: null, invoicedAt: null
    };
  }
  function live() { return DB.orders.filter(function (o) { return !o.deletedAt; }); }
  function sorted() {
    return live().slice().sort(function (a, b) {
      if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? -1 : 1;
      return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
    });
  }
  function getOrder(id) { for (var i = 0; i < DB.orders.length; i++) if (DB.orders[i].id === id) return DB.orders[i]; return null; }
  function upsert(o) {
    o.updatedAt = nowISO();
    var found = false;
    for (var i = 0; i < DB.orders.length; i++) if (DB.orders[i].id === o.id) { DB.orders[i] = o; found = true; break; }
    if (!found) DB.orders.push(o);
    persist();
    markDirty(o.id);          // queue it for the cloud
  }

  /* ================= derived money ================= */
  function grand(o) { return o.totalCents == null ? null : o.totalCents + (o.deliveryFeeCents || 0); }
  function paid(o) { return (o.payments || []).reduce(function (a, p) { return a + (p.cents || 0); }, 0); }
  function balance(o) { var g = grand(o); return g == null ? null : g - paid(o); }
  function isOverdue(o) { var b = balance(o); return b != null && b > 0 && o.eventDate < todayISO(); }

  function methodLabel(v) {
    for (var i = 0; i < METHODS.length; i++) if (METHODS[i].v === v) return METHODS[i].label;
    return v || "";
  }
  function moneyChip(o) {
    if (o.kind === "reminder") return null;
    var g = grand(o), p = paid(o), b = balance(o);
    if (g == null) return { cls: "noprice", text: "Price?" };
    if (b <= 0) return { cls: "paid", text: "✓ Paid" };
    if (isOverdue(o)) return { cls: "collect", text: "‼ COLLECT " + money(b) };
    if (p > 0) return { cls: "owes", text: "Owes " + money(b) };
    if (o.noDepositNeeded) return { cls: "noprice", text: money(g) };
    return { cls: "nodep", text: "⚠ No deposit · " + money(g) };
  }

  function monthStats(mk) {
    var os = live().filter(function (o) { return o.kind === "order" && monthKey(o.eventDate) === mk; });
    var firm = os.filter(function (o) { return !o.tentative; });
    var worth = 0, paidSum = 0, owed = 0, needPrice = 0, tentSum = 0, tentCount = 0, tbd = 0;
    firm.forEach(function (o) { var g = grand(o); if (g != null) worth += g; });
    firm.forEach(function (o) { paidSum += paid(o); });
    os.forEach(function (o) {
      var g = grand(o);
      if (g == null) { needPrice++; return; }
      if (o.tentative) { tentSum += g; tentCount++; return; }
      owed += Math.max(0, g - paid(o));
      if (o.deliveryTBD || o.totalInferred) tbd++;
    });
    // count every real order in the month (tentative included) so it always matches
    // the number of rows she can actually see in the list
    return { count: os.length, firmCount: firm.length, worth: worth, paidSum: paidSum, owed: owed, needPrice: needPrice, tentSum: tentSum, tentCount: tentCount, tbd: tbd, all: os };
  }
  function owedEverywhere() {
    var total = 0, n = 0;
    live().forEach(function (o) {
      if (o.kind !== "order" || o.tentative) return;
      var g = grand(o); if (g == null) return;
      var b = g - paid(o);
      if (b > 0) { total += b; n++; }
    });
    return { total: total, count: n };
  }
  function overdueList() { return sorted().filter(function (o) { return o.kind === "order" && isOverdue(o); }); }

  // Money actually marked as received. `prefix` filters on the PAYMENT date
  // ("2026" = year to date, "2026-07" = that month, "" = all time).
  function received(prefix) {
    var t = 0;
    live().forEach(function (o) {
      if (o.kind !== "order") return;
      (o.payments || []).forEach(function (p) {
        if (!prefix || (p.date || "").indexOf(prefix) === 0) t += p.cents || 0;
      });
    });
    return t;
  }
  function receivedAllTime() { return received(""); }
  // Orders she has actually finished and handed over — her "completed" pile.
  // A deposit landing does NOT make an order complete; she has to mark it done.
  function completedIn(prefix) {
    var value = 0, count = 0, collected = 0;
    live().forEach(function (o) {
      if (o.kind !== "order" || !o.done) return;
      if (prefix && (o.eventDate || "").indexOf(prefix) !== 0) return;
      count++;
      var g = grand(o);
      if (g != null) value += g;
      collected += paid(o);
    });
    return { value: value, count: count, collected: collected };
  }

  // Work already booked for days that haven't happened yet.
  function futureBooked() {
    var t = todayISO(), value = 0, count = 0, outstanding = 0, unpriced = 0;
    live().forEach(function (o) {
      if (o.kind !== "order" || o.eventDate < t) return;
      count++;
      var g = grand(o);
      if (g == null) { unpriced++; return; }
      if (o.tentative) return;
      value += g;
      outstanding += Math.max(0, g - paid(o));
    });
    return { value: value, count: count, outstanding: outstanding, unpriced: unpriced };
  }
  // Every month that has any order, newest first.
  function monthsWithOrders() {
    var seen = {};
    live().forEach(function (o) { if (o.kind === "order") seen[monthKey(o.eventDate)] = true; });
    return Object.keys(seen).sort().reverse();
  }

  /* ================= photos: IndexedDB ================= */
  var idb = null;
  function openDB() {
    return new Promise(function (res, rej) {
      if (idb) return res(idb);
      if (!window.indexedDB) return rej(new Error("no indexeddb"));
      var rq = indexedDB.open("blossoms", 2);
      rq.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", { keyPath: "id" });
        if (!d.objectStoreNames.contains("thumbs")) d.createObjectStore("thumbs", { keyPath: "id" });
        // second, independent copy of every order + rolling restore points
        if (!d.objectStoreNames.contains("safety")) d.createObjectStore("safety", { keyPath: "k" });
      };
      rq.onsuccess = function () { idb = rq.result; res(idb); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbPut(store, rec) {
    return openDB().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(store, "readwrite");
        tx.objectStore(store).put(rec);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(store, id) {
    return openDB().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(store, "readonly");
        var rq = tx.objectStore(store).get(id);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(store, id) {
    return openDB().then(function (d) {
      return new Promise(function (res) {
        var tx = d.transaction(store, "readwrite");
        tx.objectStore(store).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      });
    });
  }

  function idbAll(store) {
    return openDB().then(function (d) {
      return new Promise(function (res) {
        var tx = d.transaction(store, "readonly");
        var rq = tx.objectStore(store).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { res([]); };
      });
    });
  }

  /* ================= FAIL-SAFE =================
     Every save is written twice: localStorage (fast, primary) and IndexedDB
     (independent store). Plus rolling restore points so a bad edit or an
     accidental delete is always recoverable. */
  var SNAP_KEEP = 12;
  var safetyInfo = { copies: 1, lastMirrorAt: null, restorePoints: 0 };
  var recoveredFrom = null;

  function mirror(json) {
    var at = nowISO();
    idbPut("safety", { k: "current", json: json, at: at })
      .then(function () { safetyInfo.lastMirrorAt = at; safetyInfo.copies = 2; })
      .catch(function (e) { console.warn("mirror failed", e); });
    idbPut("safety", { k: "snap-" + Date.now(), json: json, at: at })
      .then(trimSnaps)
      .catch(function () { });
  }
  function trimSnaps() {
    return idbAll("safety").then(function (rows) {
      var snaps = rows.filter(function (r) { return /^snap-/.test(r.k); })
        .sort(function (a, b) { return a.k < b.k ? 1 : -1; });
      safetyInfo.restorePoints = Math.min(snaps.length, SNAP_KEEP);
      snaps.slice(SNAP_KEEP).forEach(function (s) { idbDel("safety", s.k); });
    });
  }
  // On boot: if the primary store is empty/broken but the mirror has orders, put them back.
  function bootRecover() {
    return idbAll("safety").then(function (rows) {
      var cur = rows.filter(function (r) { return r.k === "current"; })[0];
      safetyInfo.restorePoints = rows.filter(function (r) { return /^snap-/.test(r.k); }).length;
      if (cur) { safetyInfo.copies = 2; safetyInfo.lastMirrorAt = cur.at; }
      if (live().length || !cur || !cur.json) return;
      var p;
      try { p = JSON.parse(cur.json); } catch (e) { return; }
      if (!p || !Array.isArray(p.orders)) return;
      var n = p.orders.filter(function (o) { return !o.deletedAt; }).length;
      if (!n) return;
      DB = p;
      try { localStorage.setItem(K_ORDERS, cur.json); } catch (e) { }
      recoveredFrom = n;
      router();
    }).catch(function () { });
  }
  function renderRecoveredBar() {
    if (!recoveredFrom) return;
    var b = el("div", "ostrip good");
    b.appendChild(el("span", null, "✓ Your " + recoveredFrom + " orders were restored from the backup copy on this device."));
    root.appendChild(b);
  }
  function safetyLine() {
    var n = live().filter(function (o) { return o.kind === "order"; }).length;
    var box = el("div", "osafety");
    if (!n) { box.appendChild(el("span", null, "No orders saved yet.")); return box; }
    var parts = ["✓ " + n + " order" + (n === 1 ? "" : "s") + " saved in " + safetyInfo.copies + " place" + (safetyInfo.copies === 1 ? "" : "s") + " on this device"];
    if (safetyInfo.restorePoints) parts.push(safetyInfo.restorePoints + " restore points");
    parts.push(DB.meta.lastBackupAt ? "last copy saved " + fmtLong(DB.meta.lastBackupAt.slice(0, 10)) : "no copy saved off this device yet");
    box.appendChild(el("span", null, parts.join(" · ")));
    return box;
  }

  var urlCache = {};
  function thumbURL(id) {
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return idbGet("thumbs", id).then(function (r) {
      if (!r || !r.blob) return null;
      urlCache[id] = URL.createObjectURL(r.blob);
      return urlCache[id];
    }).catch(function () { return null; });
  }
  function fullURL(id) {
    return idbGet("photos", id).then(function (r) { return r && r.blob ? URL.createObjectURL(r.blob) : null; }).catch(function () { return null; });
  }

  /* ---- image pipeline: decode -> step-halve downscale -> webp/jpeg ---- */
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return decodeImg(file); });
    }
    return decodeImg(file);
  }
  function decodeImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function (e) { URL.revokeObjectURL(url); rej(e); };
      img.src = url;
    });
  }
  function toBlob(canvas, quality) {
    return new Promise(function (res) {
      canvas.toBlob(function (b) {
        if (b && b.type === "image/webp") return res(b);
        canvas.toBlob(function (b2) { res(b2 || b); }, "image/jpeg", Math.min(0.9, quality + 0.02));
      }, "image/webp", quality);
    });
  }
  function scaleTo(src, longEdge, quality) {
    var w = src.width, h = src.height;
    var scale = Math.min(1, longEdge / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    var cur = src, cw = w, ch = h, canvas = null;
    // step-halve to avoid iOS aliasing
    while (cw > tw * 2 && ch > th * 2) {
      cw = Math.max(tw, Math.round(cw / 2)); ch = Math.max(th, Math.round(ch / 2));
      var c = document.createElement("canvas"); c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(cur, 0, 0, cw, ch);
      if (canvas) { canvas.width = canvas.height = 0; }
      canvas = c; cur = c;
    }
    var out = document.createElement("canvas"); out.width = tw; out.height = th;
    var ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, tw, th);
    if (canvas) canvas.width = canvas.height = 0;
    return toBlob(out, quality).then(function (b) { out.width = out.height = 0; return { blob: b, w: tw, h: th }; });
  }
  function sha256(buf) {
    if (!(crypto && crypto.subtle)) return Promise.resolve(uuid().replace(/-/g, ""));
    return crypto.subtle.digest("SHA-256", buf).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }
  // Sequential only — concurrent decodes of 4000px photos crash mobile Safari.
  function ingest(file) {
    return decode(file).then(function (bmp) {
      return scaleTo(bmp, 1400, 0.8).then(function (full) {
        return scaleTo(bmp, 320, 0.7).then(function (thumb) {
          if (bmp.close) bmp.close();
          return full.blob.arrayBuffer().then(function (buf) {
            return sha256(buf).then(function (id) {
              return idbPut("photos", { id: id, blob: full.blob, w: full.w, h: full.h, bytes: full.blob.size, type: full.blob.type })
                .then(function () { return idbPut("thumbs", { id: id, blob: thumb.blob, w: thumb.w, h: thumb.h }); })
                .then(function () { return id; });
            });
          });
        });
      });
    });
  }

  /* ================= app shell ================= */
  var root = el("div", "oscreen");
  root.id = "oapp";
  document.body.insertBefore(root, document.body.firstChild);
  var invoiceScreen = $("screen-invoice");

  var state = { tab: "list", tickerMonth: monthKey(todayISO()), calMonth: monthKey(todayISO()), justSaved: null, justSavedId: null, filter: null, monthFilter: null, lightbox: null };

  function go(hash) { location.hash = hash; }
  function showInvoice(on) {
    if (invoiceScreen) invoiceScreen.hidden = !on;
    root.hidden = on;
  }

  function topbar(label, target) {
    var bar = el("div", "otopbar");
    var b = el("button", "obackbtn", "‹ " + (label || "Back to my orders"));
    b.onclick = function () { go(target || "#/"); };
    bar.appendChild(b);
    return bar;
  }

  /* ================= router ================= */
  function router() {
    var h = location.hash.replace(/^#/, "") || "/";
    var q = "", qi = h.indexOf("?");
    if (qi >= 0) { q = h.slice(qi + 1); h = h.slice(0, qi); }
    var parts = h.split("/").filter(Boolean);

    if (parts[0] === "invoice") {
      showInvoice(true);
      var qp = new URLSearchParams(q);
      mountInvoiceChrome(qp.get("from"));
      var invId = qp.get("inv");
      if (invId) {
        var rec = getInvoice(invId);
        if (rec) { INV.currentId = rec.id; writeInvoiceForm(rec); }
      } else if (qp.get("new")) {
        INV.currentId = null;                      // a genuinely blank one
        writeInvoiceForm({ date: todayISO(), items: [] });
      }
      return;
    }
    showInvoice(false);
    root.innerHTML = "";
    window.scrollTo(0, 0);

    var atOrders = parts[0] === "orders";
    // the "✓ Saved" note survives the hop back to the list, then clears when she goes elsewhere
    if (!atOrders) { state.justSaved = null; state.justSavedId = null; }

    if (!parts.length) renderLanding();
    else if (parts[0] === "orders") { state.tab = parts[1] === "calendar" ? "calendar" : "list"; renderOrders(); }
    else if (parts[0] === "calendar") { state.tab = "calendar"; renderOrders(); } // legacy link
    else if (parts[0] === "new") renderForm(null);
    else if (parts[0] === "edit" && parts[1]) renderForm(getOrder(parts[1]));
    else if (parts[0] === "order" && parts[1]) renderDetail(getOrder(parts[1]));
    else if (parts[0] === "money") renderMoney();
    else if (parts[0] === "completed") renderCompleted();
    else if (parts[0] === "invoices") renderInvoices();
    else if (parts[0] === "settings") renderSettings();
    else renderLanding();
  }

  /* ================= LANDING (the two-button front door) ================= */
  function renderLanding() {
    var head = el("div", "ohead");
    var logo = el("img"); logo.src = "logo.png"; logo.alt = "";
    head.appendChild(logo);
    head.appendChild(el("h1", null, "Blossoms by Michele"));
    root.appendChild(head);

    renderRecoveredBar();
    renderRecoveryCard();
    renderStandaloneBar();

    var sync = el("div", "osync"); sync.id = "osync"; sync.style.display = "none";
    root.appendChild(sync);
    paintSyncLine();

    root.appendChild(buildHero());

    // ---- find any customer, past or upcoming, right from the front page ----
    var allOrders = live().filter(function (o) { return o.kind === "order"; });
    if (allOrders.length) {
      var hs = el("div", "ohomesearch");
      var hi = el("input"); hi.type = "search";
      hi.placeholder = "🔍  Find a customer by name";
      hi.setAttribute("autocapitalize", "off"); hi.setAttribute("autocorrect", "off");
      hi.setAttribute("spellcheck", "false"); hi.setAttribute("enterkeyhint", "search");
      hi.value = state.homeSearch || "";
      hs.appendChild(hi);
      var hres = el("div", "ohomesearch-results");
      hs.appendChild(hres);
      root.appendChild(hs);

      var HALL = allOrders.slice().sort(function (a, b) { return a.eventDate < b.eventDate ? 1 : -1; }); // newest first
      function fillHome() {
        hres.innerHTML = "";
        var q = (state.homeSearch || "").trim().toLowerCase();
        if (!q) return; // only show results once she starts typing
        var hits = HALL.filter(function (o) { return ((o.name || "") + " " + (o.what || "")).toLowerCase().indexOf(q) >= 0; });
        var strip = el("div", "ostrip good");
        strip.appendChild(el("span", null, hits.length + " match" + (hits.length === 1 ? "" : "es") + ' for "' + q + '"'));
        hres.appendChild(strip);
        if (!hits.length) { hres.appendChild(el("div", "oempty", "No one by that name yet.")); return; }
        hits.slice(0, 40).forEach(function (o) { hres.appendChild(orderRow(o, { showDate: true })); });
        if (hits.length > 40) hres.appendChild(el("div", "ohint2", "Showing the first 40 — type more letters to narrow it down."));
      }
      var hdeb;
      hi.addEventListener("input", function () {
        state.homeSearch = hi.value;
        clearTimeout(hdeb); hdeb = setTimeout(fillHome, 140);
      });
      fillHome();
    }

    var bNew = el("button", "obtn obtn-primary obtn-xl", "➕  New Order");
    bNew.onclick = function () { go("#/new"); };
    root.appendChild(bNew);

    var bInv = el("button", "obtn obtn-secondary obtn-xl", "📄  Make an Invoice");
    bInv.onclick = function () { INV.currentId = null; go("#/invoice?new=1"); };
    root.appendChild(bInv);

    var nInv = liveInvoices().length;
    var bMyInv = el("button", "obtn obtn-plain", "🗂  My Invoices" + (nInv ? "  (" + nInv + ")" : ""));
    bMyInv.onclick = function () { go("#/invoices"); };
    root.appendChild(bMyInv);

    var n = live().filter(function (o) { return o.kind === "order"; }).length;
    var bList = el("button", "obtn obtn-plain", "📋  See all my orders" + (n ? "  (" + n + ")" : ""));
    bList.onclick = function () { go("#/orders"); };
    root.appendChild(bList);

    var bMoney = el("button", "obtn obtn-plain", "📊  Revenue");
    bMoney.onclick = function () { go("#/completed"); };
    root.appendChild(bMoney);

    var setBtn = el("button", "obtn obtn-plain", "⚙️  Backup & Settings");
    setBtn.onclick = function () { go("#/settings"); };
    root.appendChild(setBtn);
  }

  /* ================= ORDERS (list + calendar) ================= */
  function renderOrders() {
    root.appendChild(topbar("Back", "#/"));

    var tabs = el("div", "otabs");
    var t1 = el("button", "otab" + (state.tab === "list" ? " active" : ""), "📋 List");
    var t2 = el("button", "otab" + (state.tab === "calendar" ? " active" : ""), "📅 Calendar");
    t1.onclick = function () { go("#/orders"); };
    t2.onclick = function () { go("#/orders/calendar"); };
    tabs.appendChild(t1); tabs.appendChild(t2);
    root.appendChild(tabs);

    if (state.justSaved) root.appendChild(el("div", "osaved", "✓ Saved — " + state.justSaved));

    var od = overdueList();
    if (od.length) {
      var owed = od.reduce(function (a, o) { return a + Math.max(0, balance(o) || 0); }, 0);
      var strip = el("div", "ostrip red tappable");
      strip.appendChild(el("span", null, od.length + (od.length === 1 ? " person owes" : " people owe") + " you " + money(owed) + " for orders already done."));
      strip.onclick = function () { state.filter = state.filter === "overdue" ? null : "overdue"; router(); };
      root.appendChild(strip);
    }

    if (state.filter || state.monthFilter) {
      var fs = el("div", "ostrip amber tappable");
      var fb2 = futureBooked();
      var rec = visibleOrders();
      var txt = state.monthFilter ? "Showing " + monthLabel(state.monthFilter) + " only."
        : state.filter === "upcoming" ? "Coming up — " + fb2.count + " order" + (fb2.count === 1 ? "" : "s") + " worth " + money(fb2.value)
        : state.filter === "received" ? "Completed — " + rec.length + " order" + (rec.length === 1 ? "" : "s") + " finished, worth " + money(rec.reduce(function (a, o) { return a + (grand(o) || 0); }, 0))
        : state.filter === "noprice" ? "Showing only orders that need a price."
        : "Showing only orders that still owe you.";
      fs.appendChild(el("span", null, txt));
      var x = el("button", null, "Show all");
      x.onclick = function (e) { e.stopPropagation(); state.filter = null; state.monthFilter = null; router(); };
      fs.appendChild(x);
      root.appendChild(fs);
    }

    if (state.tab === "list") renderList(); else renderCalendar();

    var bNew = el("button", "obtn obtn-primary", "➕  New Order");
    bNew.onclick = function () { go("#/new"); };
    root.appendChild(bNew);
  }

  /* The front-door numbers: what's booked ahead vs what's actually landed. */
  function buildHero() {
    var year = todayISO().slice(0, 4);
    var fb = futureBooked(), comp = completedIn(year);
    var box = el("div", "oticker ohero");

    var split = el("div", "ohero-split");

    // whole dollars in the hero (cents don't matter in a summary and cause overflow),
    // and shrink the font for longer numbers so it never clips the tile
    function num(cents) {
      var whole = Math.round((cents || 0) / 100);
      var txt = "$" + whole.toLocaleString("en-US");
      var n = el("div", "ohero-num", txt);
      var L = txt.length;
      n.style.fontSize = L > 8 ? "26px" : L > 7 ? "30px" : L > 6 ? "34px" : "38px";
      return n;
    }

    var a = el("div", "ohero-half");
    a.appendChild(el("div", "otick-label", "COMING UP"));
    a.appendChild(num(fb.value));
    a.appendChild(el("div", "ohero-sub", fb.count + " order" + (fb.count === 1 ? "" : "s") + " booked"));
    split.appendChild(a);

    var b = el("div", "ohero-half");
    b.appendChild(el("div", "otick-label", "COMPLETED " + year));
    b.appendChild(num(comp.value));
    b.appendChild(el("div", "ohero-sub", comp.count
      ? comp.count + " order" + (comp.count === 1 ? "" : "s") + " finished"
      : "nothing finished yet"));
    split.appendChild(b);

    box.appendChild(split);
    a.style.cursor = "pointer";
    a.onclick = function () { state.filter = "upcoming"; state.monthFilter = null; go("#/orders"); };
    a.appendChild(el("div", "ohero-tap", "Tap to see them ›"));

    b.style.cursor = "pointer";
    b.onclick = function () { go("#/completed"); };
    b.appendChild(el("div", "ohero-tap", "See the charts ›"));

    return box;
  }

  /* ================= MONEY, MONTH BY MONTH ================= */
  function renderMoney() {
    root.appendChild(topbar("Back", "#/"));
    root.appendChild(el("h2", null, "Money month by month"));

    var months = monthsWithOrders();
    if (!months.length) {
      root.appendChild(el("div", "oempty", "No orders yet."));
      return;
    }
    var totV = 0, totR = 0, totO = 0, totN = 0;
    months.forEach(function (mk) {
      var st = monthStats(mk);
      totV += st.worth; totR += st.paidSum; totO += st.owed; totN += st.count;
    });
    var sumCard = el("div", "ocard");
    sumCard.appendChild(el("h3", null, "Everything, all time"));
    [["Orders", String(totN)], ["Worth", money(totV)], ["Received", money(totR)], ["Still owed", money(totO)]]
      .forEach(function (r) {
        var row = el("div", "omoneyrow");
        row.appendChild(el("span", null, r[0])); row.appendChild(el("b", null, r[1]));
        sumCard.appendChild(row);
      });
    root.appendChild(sumCard);

    var now = monthKey(todayISO());
    months.forEach(function (mk) {
      var st = monthStats(mk);
      var card = el("button", "omonthcard" + (mk === now ? " current" : ""));
      var top = el("div", "omc-top");
      top.appendChild(el("span", "omc-name", monthLabel(mk)));
      // "$0" reads as "you earned nothing"; when nothing is priced yet, say so
      top.appendChild(el("span", "omc-val", st.worth > 0 ? money(st.worth) : "—"));
      card.appendChild(top);

      var bar = el("div", "omc-bar");
      var pct = st.worth > 0 ? Math.max(2, Math.min(100, Math.round((st.paidSum / st.worth) * 100))) : 0;
      var fill = el("div", "omc-fill"); fill.style.width = pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);

      var meta = el("div", "omc-meta");
      meta.appendChild(el("span", null, st.count + " order" + (st.count === 1 ? "" : "s")));
      meta.appendChild(el("span", "omc-got", money(st.paidSum) + " received"));
      if (st.owed > 0) meta.appendChild(el("span", "omc-owed", money(st.owed) + " owed"));
      if (st.needPrice > 0) meta.appendChild(el("span", "omc-owed", st.needPrice + " need a price"));
      card.appendChild(meta);

      card.onclick = function () { state.monthFilter = mk; state.filter = null; go("#/orders"); };
      root.appendChild(card);
    });
  }

  /* ================= COMPLETED + REVENUE CHARTS ================= */
  function moneyShort(c) {
    if (c == null) return "$0";
    var d = c / 100;
    if (d >= 1000) { var k = d / 1000; return "$" + (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k"; }
    return "$" + Math.round(d);
  }
  function completedOrders() { return live().filter(function (o) { return o.kind === "order" && o.done; }); }
  function completedByYear() {
    var y = {};
    completedOrders().forEach(function (o) {
      var yr = o.eventDate.slice(0, 4); if (!/^\d{4}$/.test(yr)) return;
      (y[yr] = y[yr] || { count: 0, total: 0 }); y[yr].count++; y[yr].total += grand(o) || 0;
    });
    return y;
  }
  function completedByMonth(year) {
    var m = []; for (var i = 0; i < 12; i++) m.push({ count: 0, total: 0 });
    completedOrders().forEach(function (o) {
      if (o.eventDate.slice(0, 4) !== year) return;
      var mo = parseInt(o.eventDate.slice(5, 7), 10) - 1;
      if (mo < 0 || mo > 11) return;
      m[mo].count++; m[mo].total += grand(o) || 0;
    });
    return m;
  }
  // { "2026": {t:[12 totals], c:[12 counts]}, ... } — the whole book, for the year-over-year view
  function completedMatrix() {
    var mat = {};
    completedOrders().forEach(function (o) {
      var yr = o.eventDate.slice(0, 4); if (!/^\d{4}$/.test(yr)) return;
      var mo = parseInt(o.eventDate.slice(5, 7), 10) - 1; if (mo < 0 || mo > 11) return;
      if (!mat[yr]) { mat[yr] = { t: [0,0,0,0,0,0,0,0,0,0,0,0], c: [0,0,0,0,0,0,0,0,0,0,0,0] }; }
      mat[yr].t[mo] += grand(o) || 0; mat[yr].c[mo]++;
    });
    return mat;
  }

  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // single-series bar chart; items: [{label,value,selected,onClick}]
  function barChart(items, opts) {
    opts = opts || {};
    var n = items.length, H = opts.height || 172;
    var padT = 24, padB = 30, padX = 8;
    var W = Math.max(opts.width || 340, n * (opts.slot || 30));
    var innerH = H - padT - padB;
    var max = Math.max.apply(null, items.map(function (i) { return i.value || 0; }).concat([1]));
    var slot = (W - padX * 2) / n, bw = Math.min(opts.maxBar || 44, slot * 0.6);
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "obars", preserveAspectRatio: "xMidYMid meet" });
    // baseline
    svg.appendChild(svgEl("line", { x1: padX, y1: padT + innerH + .5, x2: W - padX, y2: padT + innerH + .5, class: "obaseline" }));
    items.forEach(function (it, i) {
      var x = padX + slot * i + slot / 2;
      var h = it.value > 0 ? Math.max(3, innerH * (it.value / max)) : 0;
      var y = padT + innerH - h;
      if (it.onClick) {
        var hit = svgEl("rect", { x: padX + slot * i, y: padT, width: slot, height: innerH + 6, fill: "transparent" });
        hit.style.cursor = "pointer"; hit.addEventListener("click", it.onClick); svg.appendChild(hit);
      }
      if (h > 0) svg.appendChild(svgEl("rect", { x: x - bw / 2, y: y, width: bw, height: h, rx: 5, class: "obar" + (it.selected ? " sel" : "") }));
      if (it.value > 0) {
        var v = svgEl("text", { x: x, y: y - 6, class: "obar-val" }); v.textContent = moneyShort(it.value); svg.appendChild(v);
      }
      var lab = svgEl("text", { x: x, y: H - 10, class: "obar-lab" + (it.selected ? " sel" : "") }); lab.textContent = it.label; svg.appendChild(lab);
    });
    return svg;
  }

  // grouped multi-year bars. series: [{year,color,totals:[12]}] newest-first; 12 month slots
  function yoyChart(series, opts) {
    opts = opts || {};
    var MN3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var nS = series.length, H = opts.height || 194, padT = 12, padB = 24, padX = 6, W = 360;
    var innerH = H - padT - padB;
    var max = 1;
    series.forEach(function (s) { for (var mi = 0; mi < 12; mi++) if (s.totals[mi] > max) max = s.totals[mi]; });
    var slot = (W - padX * 2) / 12, groupW = slot * 0.8, bw = groupW / nS;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "obars", preserveAspectRatio: "xMidYMid meet" });
    svg.appendChild(svgEl("line", { x1: padX, y1: padT + innerH + .5, x2: W - padX, y2: padT + innerH + .5, class: "obaseline" }));
    for (var mi = 0; mi < 12; mi++) {
      (function (mi) {
        var gx = padX + slot * mi + (slot - groupW) / 2;
        if (opts.selectedMonth === mi + 1) {
          svg.appendChild(svgEl("rect", { x: padX + slot * mi + 1, y: padT - 2, width: slot - 2, height: innerH + 5, rx: 6, class: "oyoy-selbg" }));
        }
        series.forEach(function (s, si) {
          var v = s.totals[mi]; if (!(v > 0)) return;
          var h = Math.max(2, innerH * (v / max));
          var r = svgEl("rect", { x: (gx + bw * si + 0.4).toFixed(1), y: (padT + innerH - h).toFixed(1), width: Math.max(2, bw - 0.8).toFixed(1), height: h.toFixed(1), rx: 2 });
          r.setAttribute("fill", s.color); svg.appendChild(r);
        });
        var lab = svgEl("text", { x: padX + slot * mi + slot / 2, y: H - 8, class: "obar-lab" + (opts.selectedMonth === mi + 1 ? " sel" : "") });
        lab.textContent = MN3[mi]; svg.appendChild(lab);
        // transparent tap target LAST so it sits above the bars + label (else those opaque
        // shapes swallow the tap and the drill-down does nothing when she taps a bar)
        if (opts.onMonth) {
          var hit = svgEl("rect", { x: padX + slot * mi, y: padT - 2, width: slot, height: innerH + padB, fill: "transparent" });
          hit.setAttribute("pointer-events", "all"); hit.style.cursor = "pointer";
          hit.addEventListener("click", function () { opts.onMonth(mi); });
          svg.appendChild(hit);
        }
      })(mi);
    }
    return svg;
  }

  function renderCompleted() {
    root.appendChild(topbar("Back", "#/"));

    var byYear = completedByYear();
    var years = Object.keys(byYear).sort();               // ascending: ["2023",...,"2026"]
    var MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (!years.length) {
      root.appendChild(el("h2", null, "Revenue history"));
      root.appendChild(el("div", "oempty", "No finished orders yet. When you finish an order, tap the date circle to mark it done."));
      return;
    }
    var mat = completedMatrix();
    var yearsDesc = years.slice().reverse();               // newest first: ["2026","2025",...]
    var curYear = yearsDesc[0];

    var grand2 = 0, cnt = 0;
    years.forEach(function (y) { grand2 += byYear[y].total; cnt += byYear[y].count; });
    root.appendChild(el("h2", null, "Revenue history"));
    root.appendChild(el("div", "oh2sub", money(grand2) + " all time · " + cnt + " orders"));

    // newest year = green (ties to the "Revenue" button + legend); then rose, gold, plum…
    var YEAR_PALETTE = ["#5c7a54", "#d76c7d", "#b8862f", "#9a7aa8", "#5f8aa8", "#c0894a"];
    var series = yearsDesc.map(function (y, i) {
      return { year: y, color: YEAR_PALETTE[i % YEAR_PALETTE.length], totals: mat[y] ? mat[y].t : [0,0,0,0,0,0,0,0,0,0,0,0] };
    });

    // ---- legend ----
    var leg = el("div", "oyoy-legend");
    series.forEach(function (s) {
      var it = el("span", "oyoy-legitem");
      var dot = el("span", "oyoy-dot"); dot.style.background = s.color; it.appendChild(dot);
      it.appendChild(document.createTextNode(s.year));
      leg.appendChild(it);
    });
    root.appendChild(leg);
    root.appendChild(el("div", "oyoy-hint", "👆 Tap any month to see those orders below"));

    function drillMonth(m1) {   // m1 = 1-12
      state.completedShowAll = false;
      state.completedMonth = (state.completedMonth === m1) ? null : m1;
      state.scrollCompletedList = state.completedMonth != null;   // jump to the results, but not when clearing
      router();
    }

    // ---- grouped year-over-year bar chart ----
    var gc = el("div", "ocard oyoy-chartcard");
    gc.appendChild(yoyChart(series, {
      selectedMonth: state.completedMonth,
      onMonth: function (mi) { drillMonth(mi + 1); }
    }));
    root.appendChild(gc);

    // ---- the numbers: every month, every year, this year vs last ----
    var tbl = el("div", "oyoy-table"); tbl.style.setProperty("--yoy-cols", yearsDesc.length);
    var hr = el("div", "oyoy-row oyoy-head");
    hr.appendChild(el("div", "oyoy-mon", ""));
    yearsDesc.forEach(function (y) { hr.appendChild(el("div", "oyoy-cell", y)); });
    tbl.appendChild(hr);
    MN.forEach(function (mn, mi) {
      var row = el("div", "oyoy-row" + (state.completedMonth === mi + 1 ? " sel" : ""));
      row.appendChild(el("div", "oyoy-mon", mn));
      yearsDesc.forEach(function (y, yi) {
        var v = mat[y] ? mat[y].t[mi] : 0;
        var cell = el("div", "oyoy-cell" + (y === curYear ? " cur" : ""));
        cell.appendChild(el("div", "oyoy-amt", v > 0 ? moneyShort(v) : "—"));
        if (y === curYear && v > 0) {
          var prev = yearsDesc[yi + 1], pv = (prev && mat[prev]) ? mat[prev].t[mi] : 0;
          if (pv > 0) {
            var pct = Math.round((v - pv) / pv * 100);
            cell.appendChild(el("div", "oyoy-pct " + (pct >= 0 ? "up" : "down"), (pct >= 0 ? "+" : "") + pct + "%"));
          }
        }
        row.appendChild(cell);
      });
      row.onclick = function () { drillMonth(mi + 1); };
      tbl.appendChild(row);
    });
    root.appendChild(tbl);

    // ---- browsable list of every finished order (customer search lives on the home page) ----
    state.completedSearch = "";
    var listWrap = el("div");
    root.appendChild(listWrap);

    var ALL = completedOrders().sort(function (a, b) { return a.eventDate < b.eventDate ? 1 : -1; }); // newest first
    var CAP = 60;

    function fillList() {
      listWrap.innerHTML = "";
      var q = (state.completedSearch || "").trim().toLowerCase();
      var list, header, capped = false;

      if (q) {
        list = ALL.filter(function (o) { return ((o.name || "") + " " + (o.what || "")).toLowerCase().indexOf(q) >= 0; });
        header = list.length + " match" + (list.length === 1 ? "" : "es") + ' for "' + q + '"';
      } else if (state.completedMonth) {
        list = ALL.filter(function (o) { return parseInt(o.eventDate.slice(5, 7), 10) === state.completedMonth; });
        var mtot = list.reduce(function (a, o) { return a + (grand(o) || 0); }, 0);
        header = "Every " + MN[state.completedMonth - 1] + " — " + list.length + " order" + (list.length === 1 ? "" : "s") + " · " + money(mtot);
      } else if (state.completedShowAll) {
        list = ALL;
        header = "All " + ALL.length + " finished orders — newest first";
      } else {
        list = ALL.slice(0, CAP);
        capped = ALL.length > CAP;
        header = "Your " + list.length + " most recent finished orders";
      }

      var strip = el("div", "ostrip good");
      strip.appendChild(el("span", null, header));
      if (state.completedMonth && !q) {
        var clr = el("button", null, "Show all");
        clr.onclick = function () { state.completedMonth = null; router(); };
        strip.appendChild(clr);
      }
      listWrap.appendChild(strip);

      var curMonth = null, showMonthHeaders = !q; // group by month unless searching
      list.forEach(function (o) {
        if (showMonthHeaders) {
          var mk = o.eventDate.slice(0, 7);
          if (mk !== curMonth) { curMonth = mk; listWrap.appendChild(el("div", "omonth", monthLabel(mk).toUpperCase())); }
        }
        listWrap.appendChild(orderRow(o));
      });

      if (!list.length) listWrap.appendChild(el("div", "oempty", "No finished orders match that."));
      if (capped) {
        var more = el("button", "obtn obtn-plain", "⌄ Show all " + ALL.length + " orders");
        more.onclick = function () { state.completedShowAll = true; fillList(); };
        listWrap.appendChild(more);
      }
    }

    fillList();

    // after a drill tap, router() has already scrolled to the top; bring the filtered
    // list into view so the orders she asked for are what she sees (not the chart again)
    if (state.scrollCompletedList) {
      state.scrollCompletedList = false;
      if (listWrap.firstChild) listWrap.scrollIntoView({ block: "start" });
    }
  }

  function buildTicker() {
    var mk = state.tickerMonth, st = monthStats(mk);
    var box = el("div", "oticker");

    var nav = el("div", "otick-nav");
    var prev = el("button", null, "‹");
    var next = el("button", null, "›");
    var lbl = el("div", "om", monthLabel(mk));
    prev.onclick = function () { state.tickerMonth = shiftMonth(mk, -1); state.calMonth = state.tickerMonth; router(); };
    next.onclick = function () { state.tickerMonth = shiftMonth(mk, 1); state.calMonth = state.tickerMonth; router(); };
    nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
    box.appendChild(nav);

    var mName = MONTHS[+mk.split("-")[1] - 1].toUpperCase();
    if (!st.count && !st.needPrice) {
      box.appendChild(el("div", "otick-big", MONTHS[+mk.split("-")[1] - 1]));
      box.appendChild(el("div", "otick-sub", "No orders yet"));
      return box;
    }
    box.appendChild(el("div", "otick-label", mName + " IS WORTH"));
    box.appendChild(el("div", "otick-big", money(st.worth)));
    box.appendChild(el("div", "otick-sub", st.count + " order" + (st.count === 1 ? "" : "s") + "  ·  " + money(st.paidSum) + " paid you"));

    var tiles = el("div", "otick-tiles");
    var t1 = el("div", "otile" + (st.owed > 0 ? " amber" : ""));
    t1.appendChild(el("b", null, money(st.owed)));
    t1.appendChild(el("span", null, "Still owed to you"));
    t1.onclick = function () { state.filter = "overdue"; router(); };
    tiles.appendChild(t1);

    if (st.needPrice > 0) {
      var t2 = el("div", "otile amber");
      t2.appendChild(el("b", null, String(st.needPrice)));
      t2.appendChild(el("span", null, "Needs a price"));
      t2.onclick = function () { state.filter = "noprice"; router(); };
      tiles.appendChild(t2);
    }
    if (st.tentCount > 0) {
      var t3 = el("div", "otile");
      t3.appendChild(el("b", null, String(st.tentCount)));
      t3.appendChild(el("span", null, "Not confirmed yet"));
      tiles.appendChild(t3);
    }
    box.appendChild(tiles);

    var oe = owedEverywhere();
    if (oe.total > 0) {
      var strip = el("div", "ostrip amber tappable");
      strip.style.marginBottom = "0";
      strip.appendChild(el("span", null, "People still owe you " + money(oe.total) + " across " + oe.count + " order" + (oe.count === 1 ? "" : "s") + "."));
      strip.onclick = function () { state.filter = "owed"; router(); };
      box.appendChild(strip);
    }
    if (st.tbd > 0) {
      box.appendChild(el("div", "otick-sub", st.tbd + " order" + (st.tbd === 1 ? " has" : "s have") + " delivery still to add — the total may go up."));
    }
    return box;
  }
  function shiftMonth(mk, d) {
    var p = mk.split("-"), y = +p[0], m = +p[1] - 1 + d;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + pad(m + 1);
  }

  /* ================= LIST ================= */
  function visibleOrders() {
    var all = sorted();
    if (state.monthFilter) all = all.filter(function (o) { return monthKey(o.eventDate) === state.monthFilter; });
    if (state.filter === "upcoming") {
      var t = todayISO();
      return all.filter(function (o) { return o.kind === "order" && o.eventDate >= t; });
    }
    // orders she has finished — most recent first
    if (state.filter === "received") {
      return all.filter(function (o) { return o.kind === "order" && o.done; })
                .sort(function (x, y) { return x.eventDate < y.eventDate ? 1 : -1; });
    }
    if (state.filter === "overdue") return all.filter(function (o) { return o.kind === "order" && isOverdue(o); });
    if (state.filter === "owed") return all.filter(function (o) { var b = balance(o); return o.kind === "order" && !o.tentative && b != null && b > 0; });
    if (state.filter === "noprice") return all.filter(function (o) { return o.kind === "order" && grand(o) == null; });
    return all;
  }

  function renderList() {
    var os = visibleOrders();
    if (!os.length) { root.appendChild(emptyState()); return; }

    var today = todayISO(), curMonth = null, wrap = el("div"), todayAnchor = null;
    var byMonth = {};
    os.forEach(function (o) { var mk = monthKey(o.eventDate); (byMonth[mk] = byMonth[mk] || []).push(o); });

    Object.keys(byMonth).sort().forEach(function (mk) {
      var group = byMonth[mk];
      var isPast = mk < monthKey(today);
      var unfinished = group.filter(function (o) { return !o.done && o.kind === "order"; }).length;
      var head = el("div", "omonth" + (isPast && unfinished ? " warn" : ""));
      head.appendChild(el("span", null, monthLabel(mk).toUpperCase()));
      var st = monthStats(mk);
      var nOrders = group.filter(function (o) { return o.kind === "order"; }).length;
      var sum = el("span", "osum", nOrders + " order" + (nOrders === 1 ? "" : "s") + (st.worth ? " · " + money(st.worth) : ""));
      head.appendChild(sum);
      wrap.appendChild(head);

      var body = el("div");
      if (isPast && !unfinished && !state.filter) {
        head.className += " collapsed";
        body.hidden = true;
        head.style.cursor = "pointer";
        var collapsedTxt = nOrders + " · all done — tap to show";
        var openTxt = nOrders + " order" + (nOrders === 1 ? "" : "s") + (st.worth ? " · " + money(st.worth) : "");
        sum.textContent = collapsedTxt;
        head.onclick = function () { body.hidden = !body.hidden; sum.textContent = body.hidden ? collapsedTxt : openTxt; };
      } else if (isPast && unfinished) {
        sum.textContent = unfinished + " not marked done ⚠︎";
      }
      group.forEach(function (o) {
        var r = orderRow(o);
        if (!todayAnchor && o.eventDate >= today) todayAnchor = r;
        body.appendChild(r);
      });
      wrap.appendChild(body);
    });
    root.appendChild(wrap);

    if (todayAnchor && !state.filter) {
      setTimeout(function () {
        try { todayAnchor.scrollIntoView({ block: "center" }); } catch (e) { }
      }, 30);
    }
  }

  function orderRow(o, opts) {
    opts = opts || {};
    var row = el("div", "orow" + (o.done ? " done" : "") + (o.kind === "reminder" ? " reminder" : "") + (state.justSavedId === o.id ? " justsaved" : ""));
    var d = dateOf(o.eventDate);

    var rail = el("button", "orail" + (o.done ? " isdone" : ""));
    rail.appendChild(el("div", "odow", d ? DOW[d.getDay()].toUpperCase() : ""));
    var dayEl = el("div", "oday", o.done ? "✓" : (d ? String(d.getDate()) : "?"));
    if (!o.done && !o.dateConfirmed) { dayEl.textContent = (d ? d.getDate() : "?") + "?"; dayEl.className += " oq"; }
    rail.appendChild(dayEl);
    rail.title = o.done ? "Mark as not done" : "Mark as done";
    rail.onclick = function (e) {
      e.stopPropagation();
      o.done = !o.done; o.doneAt = o.done ? nowISO() : null;
      upsert(o); router();
    };
    row.appendChild(rail);

    var body = el("div", "obody");
    var nm = el("div", "oname");
    if (o.name) nm.textContent = o.name; else { nm.appendChild(el("span", "odim", "No name yet")); }
    if (o.photos && o.photos.length) nm.appendChild(document.createTextNode("  🖼️"));
    if (SRC_GLYPH[o.source]) nm.appendChild(document.createTextNode(" " + SRC_GLYPH[o.source]));
    if (o.invoicedAt) nm.appendChild(document.createTextNode(" 📄"));
    body.appendChild(nm);

    // when there's no month header above (search results), spell out the full date incl. year
    if (opts.showDate && o.eventDate) body.appendChild(el("div", "orow-date", fmtShortYear(o.eventDate)));

    var what = (o.what || "").replace(/\s+/g, " ").trim();
    var w = el("div", "owhat" + (what ? "" : " empty"), what ? (what.length > 64 ? what.slice(0, 64) + "…" : what) : "⚠︎ Nothing written down yet");
    body.appendChild(w);

    var meta = el("div", "ometa");
    // in the "coming up" view the order's value is the point — lead with it
    if (state.filter === "upcoming" && grand(o) != null) meta.appendChild(el("span", "ototal", money(grand(o))));
    // in the "completed" view, what the finished order was worth
    if (state.filter === "received" && grand(o) != null) meta.appendChild(el("span", "ototal", money(grand(o))));
    var chip = moneyChip(o);
    if (chip && !o.done) { var c = el("span", "ochip " + chip.cls, chip.text); meta.appendChild(c); }
    var bits = [];
    if (o.fulfillment === "pickup") bits.push("Pick up" + (o.eventTime ? " " + fmtTime(o.eventTime) : ""));
    if (o.fulfillment === "delivery") bits.push("Delivery");
    if (o.tentative) bits.push("not confirmed");
    if (bits.length) meta.appendChild(el("span", null, bits.join(" · ")));
    if (meta.childNodes.length) body.appendChild(meta);
    row.appendChild(body);

    if (o.thumbUrls && o.thumbUrls.length) {          // photos carried over from her Notes
      var im2 = el("img", "othumb"); im2.alt = ""; im2.loading = "lazy"; im2.src = o.thumbUrls[0];
      row.appendChild(im2);
    } else if (o.videoUrls && o.videoUrls.length) {   // video-only order still gets a marker
      var vm = el("div", "othumb ovidmark", "🎬");
      row.appendChild(vm);
    } else if (o.photos && o.photos.length) {          // photos she added in the app
      var img = el("img", "othumb"); img.alt = "";
      thumbURL(o.photos[0]).then(function (u) { if (u) img.src = u; });
      row.appendChild(img);
    }

    row.onclick = function () { go("#/order/" + o.id); };
    return row;
  }

  function emptyState() {
    var e = el("div", "oempty");
    if (state.filter === "received") {
      e.appendChild(el("h3", null, "Nothing finished yet"));
      e.appendChild(el("p", null, "When you finish an order, tap the date circle on it to mark it done. Finished orders show up here."));
      var sa = el("button", "obtn obtn-plain", "Show all orders");
      sa.onclick = function () { state.filter = null; router(); };
      e.appendChild(sa);
      return e;
    }
    if (state.filter) {
      e.appendChild(el("h3", null, "Nothing here"));
      e.appendChild(el("p", null, "No orders match that right now."));
      var b = el("button", "obtn obtn-plain", "Show all orders");
      b.onclick = function () { state.filter = null; router(); };
      e.appendChild(b);
      return e;
    }
    e.appendChild(el("h3", null, "No orders yet"));
    e.appendChild(el("p", null, "Tap ➕ New Order to write down your first one. Or paste one straight from your Notes."));
    var b2 = el("button", "obtn obtn-plain", "📋 Paste a note from Notes");
    b2.onclick = function () { go("#/new?paste=1"); };
    e.appendChild(b2);
    return e;
  }

  /* ================= CALENDAR ================= */
  function renderCalendar() {
    var mk = state.calMonth;
    var head = el("div", "ocalhead");
    var prev = el("button", null, "‹"), next = el("button", null, "›");
    var title = el("div", "ocaltitle", monthLabel(mk));
    var todayBtn = el("button", null, "Today");
    prev.onclick = function () { state.calMonth = shiftMonth(mk, -1); state.tickerMonth = state.calMonth; router(); };
    next.onclick = function () { state.calMonth = shiftMonth(mk, 1); state.tickerMonth = state.calMonth; router(); };
    todayBtn.onclick = function () { state.calMonth = monthKey(todayISO()); state.tickerMonth = state.calMonth; router(); };
    head.appendChild(prev); head.appendChild(title); head.appendChild(next); head.appendChild(todayBtn);
    root.appendChild(head);

    var y = +mk.split("-")[0], m = +mk.split("-")[1] - 1;
    var first = new Date(y, m, 1), startDow = first.getDay();
    var daysIn = new Date(y, m + 1, 0).getDate();
    var prevDays = new Date(y, m, 0).getDate();

    var byDay = {};
    live().forEach(function (o) { (byDay[o.eventDate] = byDay[o.eventDate] || []).push(o); });

    var grid = el("div", "ocalgrid");
    ["S", "M", "T", "W", "T", "F", "S"].forEach(function (d) { grid.appendChild(el("div", "ocaldow", d)); });

    function cell(dayNum, iso, other) {
      var c = el("button", "ocalday" + (other ? " other" : "") + (iso === todayISO() ? " today" : ""));
      c.appendChild(el("div", "on", String(dayNum)));
      var dots = el("div", "ocaldots");
      var list = byDay[iso] || [];
      var shown = Math.min(3, list.length);
      for (var i = 0; i < shown; i++) {
        dots.appendChild(el("div", "ocaldot" + (list[i].done || list[i].kind === "reminder" ? " hollow" : "")));
      }
      c.appendChild(dots);
      var owes = list.some(function (o) { var b = balance(o); return o.kind === "order" && !o.done && b != null && b > 0; });
      c.appendChild(el("div", "ocalmoney", owes ? "$" : ""));
      c.onclick = function () {
        var t = $("agenda-" + iso);
        if (t) t.scrollIntoView({ block: "start", behavior: "smooth" });
      };
      return c;
    }
    for (var i = startDow - 1; i >= 0; i--) grid.appendChild(cell(prevDays - i, "", true));
    for (var d = 1; d <= daysIn; d++) grid.appendChild(cell(d, y + "-" + pad(m + 1) + "-" + pad(d), false));
    var filled = startDow + daysIn, trail = (7 - (filled % 7)) % 7;
    for (var t = 1; t <= trail; t++) grid.appendChild(cell(t, "", true));
    root.appendChild(grid);

    var pr = el("button", "obtn obtn-plain", "🖨 Print this month");
    pr.onclick = function () { window.print(); };
    root.appendChild(pr);

    // agenda: this month's orders, day by day
    var ag = el("div", "oagenda");
    var monthOrders = sorted().filter(function (o) { return monthKey(o.eventDate) === mk; });
    if (!monthOrders.length) {
      ag.appendChild(el("div", "oempty", "No orders in " + monthLabel(mk) + "."));
    } else {
      var curDay = null;
      monthOrders.forEach(function (o) {
        if (o.eventDate !== curDay) {
          curDay = o.eventDate;
          var h = el("div", "oday-head");
          h.id = "agenda-" + o.eventDate;
          h.appendChild(el("span", null, fmtLong(o.eventDate)));
          var cnt = byDay[o.eventDate].length;
          h.appendChild(el("span", "oc", cnt + " order" + (cnt === 1 ? "" : "s")));
          ag.appendChild(h);
        }
        ag.appendChild(orderRow(o));
      });
    }
    root.appendChild(ag);
  }

  /* ================= FORM ================= */
  function renderForm(existing) {
    var isNew = !existing;
    var o = existing ? JSON.parse(JSON.stringify(existing)) : blank();
    var pasteMode = /paste=1/.test(location.hash);

    root.appendChild(topbar("Back to my orders", existing ? "#/order/" + existing.id : "#/orders"));
    root.appendChild(el("h2", null, isNew ? "New Order" : "Change this order"));

    if (isNew && pasteMode) {
      root.appendChild(buildPasteBox(function (parsed) {
        Object.assign(o, parsed);
        root.innerHTML = "";
        renderForm2(o, isNew);
      }));
    }

    // draft recovery
    if (isNew && !pasteMode) {
      try {
        var draft = JSON.parse(localStorage.getItem(K_DRAFT) || "null");
        if (draft && (draft.name || draft.what || draft.totalCents != null)) {
          var bar = el("div", "ostrip amber");
          bar.appendChild(el("span", null, "You were in the middle of adding an order" + (draft.name ? " for " + draft.name : "") + "."));
          var keep = el("button", null, "Keep going");
          keep.onclick = function () { Object.assign(o, draft); o.id = o.id || uuid(); root.innerHTML = ""; renderForm2(o, isNew); };
          bar.appendChild(keep);
          var toss = el("button", null, "Throw away");
          toss.onclick = function () { localStorage.removeItem(K_DRAFT); bar.remove(); };
          bar.appendChild(toss);
          root.appendChild(bar);
        }
      } catch (e) { }
    }
    renderFormInto(o, isNew);
  }
  function renderForm2(o, isNew) { root.appendChild(topbar("Back to my orders", isNew ? "#/orders" : "#/order/" + o.id)); root.appendChild(el("h2", null, isNew ? "New Order" : "Change this order")); renderFormInto(o, isNew); }

  function renderFormInto(o, isNew) {
    var form = el("div");
    root.appendChild(form);

    var saveDraft = debounce(function () { if (isNew) { try { localStorage.setItem(K_DRAFT, JSON.stringify(o)); } catch (e) { } } }, 400);

    function field(labelText, node, hint) {
      var f = el("div", "ofield");
      var l = el("label", null, labelText);
      f.appendChild(l); f.appendChild(node);
      if (hint) f.appendChild(el("div", "ohint", hint));
      form.appendChild(f);
      return f;
    }
    function textInput(val, ph, attrs) {
      var i = el("input"); i.type = "text"; i.value = val || ""; if (ph) i.placeholder = ph;
      if (attrs) Object.keys(attrs).forEach(function (k) { i.setAttribute(k, attrs[k]); });
      return i;
    }
    function textArea(val, ph, rows) {
      var t = el("textarea"); t.value = val || ""; if (ph) t.placeholder = ph; t.rows = rows || 4;
      return t;
    }
    function chipRow(options, current, onPick) {
      var wrap = el("div", "ochips");
      options.forEach(function (op) {
        var b = el("button", "ochoice" + (current === op.v ? " active" : ""), op.label);
        b.onclick = function () {
          wrap.querySelectorAll(".ochoice").forEach(function (x) { x.classList.remove("active"); });
          b.classList.add("active");
          onPick(op.v);
        };
        wrap.appendChild(b);
      });
      return wrap;
    }

    /* 1 — date */
    var dateIn = el("input"); dateIn.type = "date"; dateIn.value = o.eventDate || todayISO();
    var echo = el("div", "oecho", fmtLong(dateIn.value));
    dateIn.oninput = function () { o.eventDate = dateIn.value; echo.textContent = fmtLong(o.eventDate); saveDraft(); };
    var f1 = field("What day is it for?", dateIn);
    f1.appendChild(echo);

    /* 2 — name */
    var nameIn = textInput(o.name, "Alyson — party planner", { autocapitalize: "words" });
    nameIn.oninput = function () { o.name = nameIn.value; saveDraft(); };
    field("Who is it for?", nameIn);

    /* 3 — source */
    var handleWrap = el("div"); handleWrap.style.marginTop = "10px";
    var handleIn = textInput(o.handle, "nono (really Mary)", { autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
    handleIn.oninput = function () { o.handle = handleIn.value; saveDraft(); };
    var hl = el("label", null, "Their Instagram name"); hl.style.cssText = "display:block;font-size:17px;font-weight:800;margin:10px 0 6px";
    handleWrap.appendChild(hl); handleWrap.appendChild(handleIn);
    function syncHandle() { handleWrap.style.display = o.source === "instagram" ? "" : "none"; }
    var srcRow = chipRow(SOURCES, o.source, function (v) { o.source = v; syncHandle(); saveDraft(); });
    var f3 = field("Where did they message you?", srcRow, "So you know where to go back and read the details.");
    f3.appendChild(handleWrap);
    syncHandle();

    /* 4 — what */
    var whatIn = textArea(o.what, "36 cupcakes, big rose white with gold tipping…", 6);
    whatIn.oninput = function () { o.what = whatIn.value; saveDraft(); };
    field("What do they want?", whatIn);

    /* 5 — photos */
    var photoField = el("div", "ofield");
    photoField.appendChild(el("label", null, "Photos"));
    var drop = el("div", "odrop");
    drop.appendChild(el("div", null, "📷 Add a photo"));
    drop.appendChild(el("small", null, "or paste one you copied"));
    var fileIn = el("input"); fileIn.type = "file"; fileIn.accept = "image/*"; fileIn.multiple = true; fileIn.style.display = "none";
    var strip = el("div", "ophotos");
    photoField.appendChild(drop); photoField.appendChild(fileIn); photoField.appendChild(strip);
    form.appendChild(photoField);

    function paintPhotos() {
      strip.innerHTML = "";
      (o.photos || []).forEach(function (pid) {
        var cell = el("div", "ophoto");
        var img = el("img"); img.alt = "";
        thumbURL(pid).then(function (u) { if (u) img.src = u; });
        img.onclick = function () { openLightbox(pid); };
        var x = el("button", null, "✕");
        x.onclick = function (e) {
          e.stopPropagation();
          o.photos = o.photos.filter(function (q) { return q !== pid; });
          paintPhotos(); saveDraft();
        };
        cell.appendChild(img); cell.appendChild(x);
        strip.appendChild(cell);
      });
    }
    function addFiles(files) {
      var arr = Array.prototype.slice.call(files || []).filter(function (f) { return /^image\//.test(f.type); });
      if (!arr.length) return;
      var room = PHOTO_CAP - (o.photos || []).length;
      if (room <= 0) { alert("That's " + PHOTO_CAP + " photos — that's the most for one order."); return; }
      arr = arr.slice(0, room);
      drop.firstChild.textContent = "Adding photo…";
      // strictly sequential
      var chain = Promise.resolve();
      arr.forEach(function (f) {
        chain = chain.then(function () {
          return ingest(f).then(function (id) {
            if (o.photos.indexOf(id) < 0) o.photos.push(id);
            paintPhotos();
          }).catch(function (err) {
            console.error("photo failed", err);
            o.photoError = true;
            alert("That photo could not be added. Your order is safe — try a different photo.");
          });
        });
      });
      chain.then(function () { drop.firstChild.textContent = "📷 Add a photo"; saveDraft(); });
    }
    drop.onclick = function () { fileIn.click(); };
    fileIn.onchange = function () { addFiles(fileIn.files); fileIn.value = ""; };
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
    var onPaste = function (e) {
      if (!document.body.contains(drop)) { document.removeEventListener("paste", onPaste); return; }
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); }
      if (files.length) addFiles(files); // text pastes fall through untouched
    };
    document.addEventListener("paste", onPaste);
    paintPhotos();

    /* 6 — money */
    var totalIn = textInput(o.totalCents == null ? "" : (o.totalCents / 100).toString(), "0");
    totalIn.setAttribute("inputmode", "decimal");
    var tw = el("div", "omoneywrap"); tw.appendChild(el("span", "odollar", "$")); tw.appendChild(totalIn);
    field("How much for the whole thing?", tw);

    var moneyExtra = el("div");
    form.appendChild(moneyExtra);

    var depIn = textInput("", "0"); depIn.setAttribute("inputmode", "decimal");
    var payState = o.payments && o.payments.length ? (balance(o) != null && balance(o) <= 0 ? "full" : "deposit") : "none";
    var payMethod = (o.payments && o.payments[0] && o.payments[0].method) || "zelle";
    if (o.payments && o.payments.length) depIn.value = (paid(o) / 100).toString();

    // The deposit box is always on screen — she takes a deposit on nearly every
    // order, so it should never be something she has to make appear.
    function paintMoneyExtra() {
      moneyExtra.innerHTML = "";

      var dw = el("div", "ofield");
      dw.appendChild(el("label", null, "Deposit (usually half)"));
      var w2 = el("div", "omoneywrap"); w2.appendChild(el("span", "odollar", "$")); w2.appendChild(depIn);
      dw.appendChild(w2);
      if (o.totalCents == null) dw.appendChild(el("div", "ohint", "Type the price above and this fills in at half on its own."));
      moneyExtra.appendChild(dw);

      var pf = el("div", "ofield");
      pf.appendChild(el("label", null, "Have they paid it?"));
      pf.appendChild(chipRow([
        { v: "none", label: "Not yet" }, { v: "deposit", label: "Deposit paid" }, { v: "full", label: "Paid in full" }
      ], payState, function (v) {
        payState = v;
        if (v === "full" && o.totalCents != null) depIn.value = (o.totalCents / 100).toString();
        if (v === "none") depIn.value = "";
        paintMoneyExtra();
      }));
      moneyExtra.appendChild(pf);

      if (payState !== "none") {
        var mf = el("div", "ofield");
        mf.appendChild(el("label", null, "Paid with"));
        mf.appendChild(chipRow(METHODS, payMethod, function (v) { payMethod = v; }));
        moneyExtra.appendChild(mf);
      }

      if (o.totalCents != null) {
        var depC = parseMoney(depIn.value) || 0;
        var bal = (o.totalCents + (o.deliveryFeeCents || 0)) - (payState === "none" ? 0 : depC);
        moneyExtra.appendChild(el("div", "obalance", "Balance " + money(bal)));
      }
    }
    totalIn.oninput = function () {
      var c = parseMoney(totalIn.value);
      if (c !== o.totalCents) {
        if (o.totalCents != null) o.totalHistory.push({ at: nowISO(), cents: o.totalCents });
        o.totalCents = c;
        // suggest half, but only before any payment is recorded
        if (c != null && payState === "none") depIn.value = (Math.round(c / 2) / 100).toString();
      }
      paintMoneyExtra(); saveDraft();
    };
    depIn.oninput = function () { if (payState === "none") payState = "deposit"; paintMoneyExtra(); saveDraft(); };
    paintMoneyExtra();

    /* disclosure */
    var det = el("details", "odisclose");
    var sum = el("summary", null, "➕ Add more (pick up, delivery, notes)");
    det.appendChild(sum);
    var more = el("div");
    det.appendChild(more);
    form.appendChild(det);

    function moreField(labelText, node, hint) {
      var f = el("div", "ofield");
      f.appendChild(el("label", null, labelText));
      f.appendChild(node);
      if (hint) f.appendChild(el("div", "ohint", hint));
      more.appendChild(f);
      return f;
    }
    var fulfillExtra = el("div");
    function paintFulfill() {
      fulfillExtra.innerHTML = "";
      if (o.fulfillment === "pickup") {
        var tf = el("div", "ofield");
        tf.appendChild(el("label", null, "What time?"));
        var ti = el("input"); ti.type = "time"; ti.value = o.eventTime || "";
        ti.oninput = function () { o.eventTime = ti.value; saveDraft(); };
        tf.appendChild(ti); fulfillExtra.appendChild(tf);
      } else if (o.fulfillment === "delivery") {
        var af = el("div", "ofield");
        af.appendChild(el("label", null, "Address"));
        var ta = textArea(o.address, "Where is it going?", 3);
        ta.oninput = function () { o.address = ta.value; saveDraft(); };
        af.appendChild(ta); fulfillExtra.appendChild(af);

        var df = el("div", "ofield");
        df.appendChild(el("label", null, "Delivery charge"));
        var dwrap = el("div", "omoneywrap"); dwrap.appendChild(el("span", "odollar", "$"));
        var di = textInput(o.deliveryFeeCents == null ? "" : (o.deliveryFeeCents / 100).toString(), "0");
        di.setAttribute("inputmode", "decimal");
        di.oninput = function () { o.deliveryFeeCents = parseMoney(di.value); paintMoneyExtra(); saveDraft(); };
        dwrap.appendChild(di); df.appendChild(dwrap);
        var tg = el("label", "otoggle");
        var cb = el("input"); cb.type = "checkbox"; cb.checked = !!o.deliveryTBD;
        cb.onchange = function () { o.deliveryTBD = cb.checked; saveDraft(); };
        tg.appendChild(cb); tg.appendChild(el("span", null, "Delivery not worked out yet"));
        df.appendChild(tg);
        fulfillExtra.appendChild(df);
      }
    }
    moreField("Pick up or delivery?", chipRow([
      { v: "pickup", label: "🛍️ Pick up" }, { v: "delivery", label: "🚚 Delivery" }
    ], o.fulfillment, function (v) { o.fulfillment = v; paintFulfill(); saveDraft(); }));
    more.appendChild(fulfillExtra);
    paintFulfill();

    var avoidIn = textArea(o.avoid, "No purple. No orange. She hates pearls.", 2);
    avoidIn.oninput = function () { o.avoid = avoidIn.value; saveDraft(); };
    moreField("Anything to avoid?", avoidIn);

    var aboutIn = textArea(o.aboutThem, "Super nice lady. Loves lemon curd and guava.", 3);
    aboutIn.oninput = function () { o.aboutThem = aboutIn.value; saveDraft(); };
    moreField("Anything else to remember?", aboutIn);

    var cardIn = textInput(o.cardMessage, "Happy 90th Birthday Mum!");
    cardIn.oninput = function () { o.cardMessage = cardIn.value; saveDraft(); };
    moreField("Note to put in the box", cardIn);

    var phoneIn = textInput(o.phone, ""); phoneIn.type = "tel";
    phoneIn.oninput = function () { o.phone = phoneIn.value; saveDraft(); };
    moreField("Their phone", phoneIn);

    var emailIn = textInput(o.email, ""); emailIn.type = "email";
    emailIn.setAttribute("autocapitalize", "off"); emailIn.setAttribute("autocorrect", "off");
    emailIn.oninput = function () { o.email = emailIn.value; saveDraft(); };
    moreField("Their email", emailIn);

    var altIn = textInput(o.altDateNote, "she prefers the 21st");
    altIn.oninput = function () { o.altDateNote = altIn.value; saveDraft(); };
    moreField("Other date they mentioned", altIn);

    var t1 = el("label", "otoggle");
    var c1 = el("input"); c1.type = "checkbox"; c1.checked = !!o.tentative;
    c1.onchange = function () { o.tentative = c1.checked; o.dateConfirmed = !c1.checked; saveDraft(); };
    t1.appendChild(c1); t1.appendChild(el("span", null, "Not confirmed yet"));
    more.appendChild(t1);

    var t2 = el("label", "otoggle");
    var c2 = el("input"); c2.type = "checkbox"; c2.checked = o.kind === "reminder";
    c2.onchange = function () { o.kind = c2.checked ? "reminder" : "order"; saveDraft(); };
    t2.appendChild(c2); t2.appendChild(el("span", null, "This is just a reminder, not an order"));
    more.appendChild(t2);

    /* save */
    var save = el("button", "obtn obtn-primary", "💾 Save Order");
    save.onclick = function () {
      // commit payment state
      var depC = parseMoney(depIn.value);
      o.payments = [];
      if (o.totalCents != null && payState !== "none" && depC) {
        o.payments.push({ id: uuid(), cents: depC, method: payMethod, date: todayISO(), kind: payState === "full" ? "final" : "deposit" });
      }
      if (!o.name && !o.what && o.totalCents == null) {
        if (!confirm("This order is empty. Save it anyway?")) return;
      }
      upsert(o);
      try { localStorage.removeItem(K_DRAFT); } catch (e) { }
      state.justSaved = fmtShort(o.eventDate) + (o.name ? ", " + o.name : "");
      state.justSavedId = o.id;
      state.monthFilter = null; state.filter = null;
      go("#/orders");
    };
    form.appendChild(save);

    if (!isNew) {
      var del = el("button", "obtn obtn-danger", "🗑️ Delete this order");
      del.onclick = function () {
        if (!confirm("Delete this order? It will be removed from your list.")) return;
        var real = getOrder(o.id);
        // soft delete, and stamp updatedAt so the deletion wins on other devices
        if (real) { real.deletedAt = nowISO(); real.updatedAt = nowISO(); persist(); markDirty(real.id); }
        go("#/orders");
      };
      form.appendChild(del);
    }
  }

  /* ================= paste importer ================= */
  function buildPasteBox(onParsed) {
    var box = el("div", "ocard");
    box.appendChild(el("h3", null, "Paste a note"));
    var ta = el("textarea");
    ta.rows = 6; ta.placeholder = "Paste one note from your Notes app here…";
    ta.style.cssText = "width:100%;font:inherit;font-size:18px;padding:12px;border:2px solid var(--o-line);border-radius:14px";
    box.appendChild(ta);
    var b = el("button", "obtn obtn-plain", "Read it →");
    b.onclick = function () {
      var parsed = parseNote(ta.value);
      if (!parsed) { alert("Could not read that. You can type it in below instead."); return; }
      onParsed(parsed);
    };
    box.appendChild(b);
    return box;
  }

  function parseNote(text) {
    if (!text || !text.trim()) return null;
    var t = text.trim();
    var out = {};
    var MN = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
    var m = new RegExp("\\b(" + MN + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b", "i").exec(t);
    if (m) {
      var mi = MONTHS.findIndex(function (x) { return x.toLowerCase().indexOf(m[1].toLowerCase().replace(/\.$/, "")) === 0; });
      if (mi >= 0) {
        var now = new Date(), y = now.getFullYear();
        var cand = new Date(y, mi, +m[2]);
        // her notes carry no year: assume the next occurrence
        if ((now - cand) / 86400000 > 45) cand = new Date(y + 1, mi, +m[2]);
        out.eventDate = cand.getFullYear() + "-" + pad(cand.getMonth() + 1) + "-" + pad(cand.getDate());
      }
    }
    // name: text right after the date, up to punctuation/number
    if (m) {
      var after = t.slice(m.index + m[0].length).replace(/^[\s.,:-]+/, "");
      var firstLine = after.split("\n")[0]; // a name never spans lines
      // prefer capitalised words ("Susan Yates"); fall back to one lowercase word ("mri", "karen")
      var nm = /^\??\s*([A-Z][A-Za-z'’]*(?:\s+[A-Z][A-Za-z'’]*)?)/.exec(firstLine)
            || /^\??\s*([A-Za-z'’]+)/.exec(firstLine);
      if (nm) out.name = nm[1].trim();
      if (/^\?/.test(after)) out.tentative = true;
    }
    // money: largest $ figure = total
    var amounts = [], rx = /\$\s?([\d,]+(?:\.\d{1,2})?)/g, mm;
    while ((mm = rx.exec(t))) amounts.push({ cents: Math.round(parseFloat(mm[1].replace(/,/g, "")) * 100), idx: mm.index });
    if (amounts.length) {
      var max = amounts.reduce(function (a, b) { return b.cents > a.cents ? b : a; });
      out.totalCents = max.cents;
      // a $ near deposit words is the deposit
      var dep = amounts.filter(function (a) {
        if (a === max) return false;
        var ctx = t.slice(Math.max(0, a.idx - 40), a.idx + 40).toLowerCase();
        return /deposit|half|50%|paid/.test(ctx);
      })[0];
      if (dep) {
        var meth = (/venmo|zelle|cash|check|square|credit card/i.exec(t) || [""])[0].toLowerCase();
        if (meth === "square" || meth === "credit card") meth = "card";
        out.payments = [{ id: uuid(), cents: dep.cents, method: meth || "zelle", date: todayISO(), kind: "deposit" }];
      }
    }
    if (/instagram|\bIG\b/i.test(t)) out.source = "instagram";
    else if (/\btext\b/i.test(t)) out.source = "text";
    else if (/email/i.test(t)) out.source = "email";
    if (/pick\s?up/i.test(t)) out.fulfillment = "pickup";
    else if (/deliver/i.test(t)) out.fulfillment = "delivery";
    var tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
    if (tm && out.fulfillment === "pickup") {
      var hh = +tm[1] % 12; if (/pm/i.test(tm[3])) hh += 12;
      out.eventTime = pad(hh) + ":" + (tm[2] || "00");
    }
    // everything verbatim — never rewrite her words
    out.what = t;
    if (!amounts.length && !/cake|cupcake|cookie|bouquet|dozen|oreo|pretzel|krispy|wedding|shower|birthday/i.test(t)) out.kind = "reminder";
    return out;
  }

  /* ================= DETAIL ================= */
  function renderDetail(o) {
    if (!o) { go("#/orders"); return; }
    root.appendChild(topbar("Back to my orders", "#/orders"));
    var d = el("div", "odetail");

    d.appendChild(el("h2", null, (o.name || "No name yet")));
    var sub = fmtLong(o.eventDate) + (o.eventTime ? " · " + fmtTime(o.eventTime) : "");
    if (o.tentative) sub += "  (not confirmed)";
    d.appendChild(el("div", "osubtitle", sub));

    if (o.what) { var c1 = el("div", "ocard"); c1.appendChild(el("h3", null, "What they want")); c1.appendChild(el("p", null, o.what)); d.appendChild(c1); }
    if (o.avoid) { var c2 = el("div", "ocard avoid"); c2.appendChild(el("h3", null, "Avoid")); c2.appendChild(el("p", null, o.avoid)); d.appendChild(c2); }

    var hasUrlPhotos = o.thumbUrls && o.thumbUrls.length;
    if (hasUrlPhotos || (o.photos && o.photos.length)) {
      var pc = el("div", "ocard");
      pc.appendChild(el("h3", null, "Photos"));
      var ps = el("div", "ophotos");
      if (hasUrlPhotos) {
        o.thumbUrls.forEach(function (t, i) {
          var cell = el("div", "ophoto");
          var img = el("img"); img.alt = ""; img.src = t;
          img.onclick = function () { openLightboxURL((o.photoUrls || [])[i] || t); };
          cell.appendChild(img); ps.appendChild(cell);
        });
      }
      (o.photos || []).forEach(function (pid) {
        var cell = el("div", "ophoto");
        var img = el("img"); img.alt = "";
        thumbURL(pid).then(function (u) { if (u) img.src = u; });
        img.onclick = function () { openLightbox(pid); };
        cell.appendChild(img); ps.appendChild(cell);
      });
      pc.appendChild(ps); d.appendChild(pc);
    }

    if (o.videoUrls && o.videoUrls.length) {
      var vc = el("div", "ocard");
      vc.appendChild(el("h3", null, "Videos"));
      var vs = el("div", "ovideos");
      o.videoUrls.forEach(function (u) {
        var v = el("video"); v.controls = true; v.playsInline = true; v.preload = "metadata"; v.src = u;
        vs.appendChild(v);
      });
      vc.appendChild(vs); d.appendChild(vc);
    }

    if (o.docUrls && o.docUrls.length) {
      var dc = el("div", "ocard");
      dc.appendChild(el("h3", null, "Documents"));
      o.docUrls.forEach(function (doc) {
        var a = el("a", "obtn obtn-plain odoclink", "📄 " + (doc.name || "View document"));
        a.href = doc.url; a.target = "_blank"; a.rel = "noopener";
        dc.appendChild(a);
      });
      d.appendChild(dc);
    }

    // money
    var mc = el("div", "ocard");
    mc.appendChild(el("h3", null, "Money"));
    if (grand(o) == null) {
      mc.appendChild(el("p", null, "No price yet."));
    } else {
      var r1 = el("div", "omoneyrow"); r1.appendChild(el("span", null, "Total")); r1.appendChild(el("b", null, money(o.totalCents)));
      mc.appendChild(r1);
      if (o.deliveryFeeCents) { var r2 = el("div", "omoneyrow"); r2.appendChild(el("span", null, "Delivery")); r2.appendChild(el("b", null, money(o.deliveryFeeCents))); mc.appendChild(r2); }
      (o.payments || []).forEach(function (p) {
        var r = el("div", "omoneyrow opayrow");
        var lbl = el("span", null, "She paid" + (p.method ? " by " + methodLabel(p.method) : ""));
        if (p.date) lbl.appendChild(el("small", "opaydate", " " + fmtShort(p.date)));
        r.appendChild(lbl);
        var amt = el("b", "opaid", money(p.cents));
        r.appendChild(amt);
        // a mis-entered payment must be removable — she entered one twice
        var x = el("button", "opayx", "✕");
        x.title = "Remove this payment";
        x.onclick = function () {
          if (!confirm("Remove this " + money(p.cents) + " payment?")) return;
          var real = getOrder(o.id);
          real.payments = real.payments.filter(function (q) { return q.id !== p.id; });
          upsert(real); router();
        };
        r.appendChild(x);
        mc.appendChild(r);
      });

      var bal = balance(o);
      var rb = el("div", "omoneyrow big");
      rb.appendChild(el("span", null, bal <= 0 ? "Paid in full ✓" : "Still owes you"));
      rb.appendChild(el("b", null, money(Math.max(0, bal))));
      mc.appendChild(rb);

      // overpaid almost always means the same payment was entered twice
      if (bal < 0) {
        var warn = el("div", "ostrip amber");
        warn.appendChild(el("span", null, "She's paid " + money(-bal) + " more than the total. Did you enter a payment twice? Tap the ✕ next to one to remove it."));
        mc.appendChild(warn);
      }
    }
    mc.appendChild(paymentAdder(o));
    d.appendChild(mc);

    // where / who
    var wc = el("div", "ocard");
    wc.appendChild(el("h3", null, "Details"));
    var lines = [];
    if (o.fulfillment === "pickup") lines.push("Pick up" + (o.eventTime ? " at " + fmtTime(o.eventTime) : ""));
    if (o.fulfillment === "delivery") lines.push("Delivery" + (o.address ? "\n" + o.address : ""));
    if (o.source) lines.push("Messaged on " + o.source + (o.handle ? " — " + o.handle : ""));
    if (o.phone) lines.push("Phone " + o.phone);
    if (o.email) lines.push("Email " + o.email);
    if (o.cardMessage) lines.push("Note in the box: " + o.cardMessage);
    if (o.altDateNote) lines.push("Also mentioned: " + o.altDateNote);
    if (o.aboutThem) lines.push(o.aboutThem);
    wc.appendChild(el("p", null, lines.join("\n") || "—"));
    d.appendChild(wc);

    var bDone = el("button", "obtn " + (o.done ? "obtn-plain" : "obtn-primary"), o.done ? "↩︎ Not done after all" : "✅ Mark as done");
    bDone.onclick = function () { var r = getOrder(o.id); r.done = !r.done; r.doneAt = r.done ? nowISO() : null; upsert(r); router(); };
    d.appendChild(bDone);

    var bInv = el("button", "obtn obtn-secondary", o.invoicedAt ? "📄 Invoice made " + fmtShort(o.invoicedAt.slice(0, 10)) + " · Make another" : "📄 Make an invoice for this order");
    bInv.onclick = function () { go("#/invoice?from=" + o.id); };
    d.appendChild(bInv);

    var bEdit = el("button", "obtn obtn-plain", "✏️ Change this order");
    bEdit.onclick = function () { go("#/edit/" + o.id); };
    d.appendChild(bEdit);

    root.appendChild(d);
  }

  /* Record a deposit or a final payment on an order that already exists. */
  function paymentAdder(o) {
    var wrap = el("div");
    var bal = balance(o);
    var open = el("button", "obtn obtn-primary", "💵 Enter a payment");
    wrap.appendChild(open);

    var half = o.totalCents != null ? Math.round(o.totalCents / 2) : null;
    var panel = el("div", "opaypanel"); panel.hidden = true;
    var method = "zelle";

    var f = el("div", "ofield");
    f.appendChild(el("label", null, "How much did they pay?"));
    var mw = el("div", "omoneywrap");
    mw.appendChild(el("span", "odollar", "$"));
    var amt = el("input"); amt.type = "text"; amt.setAttribute("inputmode", "decimal");
    amt.value = bal != null && bal > 0 ? (bal / 100).toString() : (half != null ? (half / 100).toString() : "");
    mw.appendChild(amt); f.appendChild(mw);
    panel.appendChild(f);

    // one-tap shortcuts for the two amounts she actually uses
    var quick = el("div", "ochips"); quick.style.marginBottom = "14px";
    if (half != null && paid(o) === 0) {
      var qh = el("button", "ochoice", "Half — " + money(half));
      qh.onclick = function () { amt.value = (half / 100).toString(); };
      quick.appendChild(qh);
    }
    if (bal != null && bal > 0) {
      var qb = el("button", "ochoice", "The rest — " + money(bal));
      qb.onclick = function () { amt.value = (bal / 100).toString(); };
      quick.appendChild(qb);
    }
    if (quick.childNodes.length) panel.appendChild(quick);

    var mf = el("div", "ofield");
    mf.appendChild(el("label", null, "Paid with"));
    var chips = el("div", "ochips");
    METHODS.forEach(function (m) {
      var b = el("button", "ochoice" + (m.v === method ? " active" : ""), m.label);
      b.onclick = function () {
        chips.querySelectorAll(".ochoice").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active"); method = m.v;
      };
      chips.appendChild(b);
    });
    mf.appendChild(chips);
    panel.appendChild(mf);

    var save = el("button", "obtn obtn-primary", "✓ Save this payment");
    save.onclick = function () {
      var c = parseMoney(amt.value);
      if (!c) { alert("Type how much they paid."); return; }
      var real = getOrder(o.id);
      var remaining = balance(real);
      // catch the double-entry before it happens rather than after
      if (remaining != null && remaining <= 0) {
        if (!confirm("This order is already paid in full.\n\nAdd another " + money(c) + " anyway?")) return;
      } else if (remaining != null && c > remaining) {
        if (!confirm("She only owes " + money(remaining) + ", but you typed " + money(c) + ".\n\nSave it anyway?")) return;
      }
      real.payments.push({
        id: uuid(), cents: c, method: method, date: todayISO(),
        kind: real.payments.length ? "final" : "deposit"
      });
      upsert(real);
      router();
    };
    panel.appendChild(save);

    var cancel = el("button", "obtn obtn-plain", "Cancel");
    cancel.onclick = function () { panel.hidden = true; open.hidden = false; };
    panel.appendChild(cancel);

    wrap.appendChild(panel);
    open.onclick = function () { panel.hidden = false; open.hidden = true; amt.focus(); };
    return wrap;
  }

  function openLightboxURL(url) {
    var lb = el("div", "olightbox");
    var img = el("img"); img.src = url;
    var back = el("button", "obtn obtn-secondary", "‹ Back");
    back.style.maxWidth = "220px";
    back.onclick = function () { lb.remove(); };
    lb.appendChild(img); lb.appendChild(back);
    lb.onclick = function (e) { if (e.target === lb) lb.remove(); };
    document.body.appendChild(lb);
  }
  function openLightbox(pid) {
    fullURL(pid).then(function (u) {
      if (!u) return;
      var lb = el("div", "olightbox");
      var img = el("img"); img.src = u;
      var back = el("button", "obtn obtn-secondary", "‹ Back");
      back.style.maxWidth = "220px";
      back.onclick = function () { lb.remove(); URL.revokeObjectURL(u); };
      lb.appendChild(img); lb.appendChild(back);
      lb.onclick = function (e) { if (e.target === lb) { lb.remove(); URL.revokeObjectURL(u); } };
      document.body.appendChild(lb);
    });
  }

  /* ================= INVOICE handoff ================= */
  function setVal(id, v) {
    var e = $(id); if (!e) return;
    e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var invoiceChrome = null, invoiceFrom = null;
  function mountInvoiceChrome(fromId) {
    if (!invoiceChrome) {
      invoiceChrome = topbar("Back to my orders", "#/");
      invoiceChrome.style.background = "var(--o-bg)";
      if (invoiceScreen) invoiceScreen.insertBefore(invoiceChrome, invoiceScreen.firstChild);
    }
    if (!fromId) { invoiceFrom = null; return; }
    var o = getOrder(fromId);
    if (!o) { invoiceFrom = null; return; }
    invoiceFrom = o.id;
    // prefill by driving the DOM — the invoice script is a closed IIFE
    setVal("deliveryDate", o.eventDate);
    setVal("billTo", o.name || "");
    if (o.fulfillment === "pickup") { var sp = $("segPickup"); if (sp) sp.click(); }
    else if (o.fulfillment === "delivery") {
      var sd = $("segDelivery"); if (sd) sd.click();
      if (o.address) setVal("addrFull", o.address); // never touch #addrSearch (fires the lookup)
    }
    var desc = document.querySelector("#items .item .idesc");
    var price = document.querySelector("#items .item .iprice");
    if (desc) setVal(desc.id || (desc.id = "o_desc0"), o.what || "");
    if (price && o.totalCents != null) setVal(price.id || (price.id = "o_price0"), (o.totalCents / 100).toString());
    var p = paid(o);
    if (p > 0) setVal("deposit", (p / 100).toString());
    if (o.fulfillment === "pickup" && o.eventTime) {
      var pr = $("payRemainder");
      if (pr) setVal("payRemainder", "Pick-up at " + fmtTime(o.eventTime));
    }
  }
  // write back that an invoice was made
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#makeBtn")) {
      if (invoiceFrom) {
        var o = getOrder(invoiceFrom);
        if (o) { o.invoicedAt = nowISO(); upsert(o); }
      }
      // make sure the finished invoice is stored, and note that a PDF went out
      autosaveInvoice();
      var rec = INV.currentId ? getInvoice(INV.currentId) : null;
      if (rec) { rec.pdfAt = nowISO(); rec.updatedAt = nowISO(); saveInvoices(); }
    }
  }, true);

  /* ================= backup / settings ================= */
  function dataURLtoBlob(u) { return fetch(u).then(function (r) { return r.blob(); }); }
  function blobToDataURL(b) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsDataURL(b);
    });
  }
  // Backups carry the pictures as well as the words, so a restore is a real restore.
  function backupJSON() {
    var payload = JSON.parse(JSON.stringify(DB));
    payload.exportedAt = nowISO();
    var wanted = {};
    live().forEach(function (o) { (o.photos || []).forEach(function (id) { wanted[id] = true; }); });
    var ids = Object.keys(wanted);
    if (!ids.length) { payload.photoData = {}; return Promise.resolve(JSON.stringify(payload, null, 2)); }
    payload.photoData = {};
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        return idbGet("photos", id).then(function (p) {
          if (!p || !p.blob) return;
          return blobToDataURL(p.blob).then(function (full) {
            return idbGet("thumbs", id).then(function (t) {
              return (t && t.blob ? blobToDataURL(t.blob) : Promise.resolve(full)).then(function (thumb) {
                payload.photoData[id] = { full: full, thumb: thumb, w: p.w, h: p.h };
              });
            });
          });
        }).catch(function () { });
      });
    }, Promise.resolve()).then(function () { return JSON.stringify(payload, null, 2); });
  }
  function doBackup() {
    var name = "Blossoms-Orders-" + todayISO() + ".json";
    backupJSON().then(function (txt) { finishBackup(name, new Blob([txt], { type: "application/json" })); });
  }
  function finishBackup(name, blob) {
    var file = null;
    try { file = new File([blob], name, { type: "application/json" }); } catch (e) { }
    function done() {
      DB.meta.lastBackupAt = nowISO(); DB.meta.changesSinceBackup = 0; persist(false); router();
    }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).then(done).catch(function (err) {
        if (err && err.name === "AbortError") return;
        downloadBlob(blob, name); done();
      });
    } else { downloadBlob(blob, name); done(); }
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function daysSinceBackup() {
    if (!DB.meta.lastBackupAt) return 999;
    return Math.floor((Date.now() - new Date(DB.meta.lastBackupAt).getTime()) / 86400000);
  }
  function renderBackupBar() {
    var n = live().filter(function (o) { return o.kind === "order"; }).length;
    if (!n) return;
    var days = daysSinceBackup(), ch = DB.meta.changesSinceBackup || 0;
    if (DB.meta.snoozeUntil && Date.now() < DB.meta.snoozeUntil) return;
    var never = !DB.meta.lastBackupAt;
    // never-backed-up starts gentle (amber) and only escalates once real work would be lost
    var level = ((!never && days >= 21) || ch >= 10) ? "red" : (never || days >= 7 || ch >= 5) ? "amber" : "good";
    var bar = el("div", "ostrip " + level);
    if (level === "good") {
      bar.appendChild(el("span", null, "Backed up " + (days === 0 ? "today" : days + " day" + (days === 1 ? "" : "s") + " ago") + " ✓"));
      root.appendChild(bar); return;
    }
    bar.appendChild(el("span", null, DB.meta.lastBackupAt
      ? "It's been " + days + " days since you saved your orders."
      : "Save a copy of your orders so you can never lose them."));
    var b = el("button", null, "SAVE MY ORDERS");
    b.onclick = function () { doBackup(); };
    bar.appendChild(b);
    var s = el("button", null, "Later");
    s.onclick = function () { DB.meta.snoozeUntil = Date.now() + 2 * 86400000; persist(false); router(); };
    bar.appendChild(s);
    root.appendChild(bar);
  }
  function renderRecoveryCard() {
    if (live().length || !DB.meta.everHadOrders) return;
    var c = el("div", "ostrip red");
    c.appendChild(el("span", null, "No orders here. If you had orders before, open your backup file to get them back."));
    var b = el("button", null, "Open backup");
    b.onclick = function () { go("#/settings"); };
    c.appendChild(b);
    root.appendChild(c);
  }
  function renderStandaloneBar() {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (isIOS && !standalone) {
      var b = el("div", "ostrip amber");
      b.appendChild(el("span", null, "Open Blossoms from the flower icon on your Home Screen. Orders typed here in Safari can disappear."));
      root.appendChild(b);
    } else if (!isIOS && live().length) {
      var b2 = el("div", "ostrip amber");
      b2.appendChild(el("span", null, "This is your computer's copy. Orders added here won't show up on your phone."));
      root.appendChild(b2);
    }
  }

  function renderSettings() {
    root.appendChild(topbar("Back to my orders", "#/"));
    root.appendChild(el("h2", null, "Backup & Settings"));

    root.appendChild(safetyLine());

    var cc = el("div", "ocard");
    cc.appendChild(el("h3", null, "Cloud backup"));
    if (cloudOn()) {
      cc.appendChild(el("p", null, "On. Every order is saved to the cloud automatically — you don't have to do anything."));
      var st = el("div", "ohint", CLOUD.lastPullAt ? "Last checked " + new Date(CLOUD.lastPullAt).toLocaleString() : "");
      cc.appendChild(st);
      var sn = el("button", "obtn obtn-plain", "↻ Check now");
      sn.onclick = function () { live().forEach(function (o) { CLOUD.pending[o.id] = 1; }); runSync(); };
      cc.appendChild(sn);
    } else {
      cc.appendChild(el("p", null, "Off — your orders are only on this phone. Type your code below to turn it on."));
      var ti = el("input"); ti.type = "text"; ti.placeholder = "your code";
      ti.setAttribute("autocapitalize", "off"); ti.setAttribute("autocorrect", "off");
      ti.setAttribute("spellcheck", "false"); ti.setAttribute("autocomplete", "off");
      ti.style.cssText = "width:100%;font:inherit;font-size:22px;font-weight:700;text-align:center;padding:16px;border:1px solid var(--o-line-2);border-radius:14px;margin-top:12px;min-height:64px";
      cc.appendChild(ti);

      var msg = el("div", "ohint", "");
      cc.appendChild(msg);

      var tb = el("button", "obtn obtn-primary", "Turn on cloud backup");
      tb.onclick = function () {
        var v = (ti.value || "").trim();
        if (!v) { msg.textContent = "Type your code in the box above first."; msg.style.color = "var(--o-amber)"; ti.focus(); return; }
        if (v.length < 6) { msg.textContent = "That code looks too short — check it and try again."; msg.style.color = "var(--o-amber)"; return; }
        msg.textContent = "Checking…"; msg.style.color = "var(--o-muted)";
        tb.disabled = true;
        // verify before saving, so a wrong code says so instead of silently failing
        fetch(CLOUD.url + "/api/orders", { headers: { "Authorization": "Bearer " + v } })
          .then(function (r) {
            tb.disabled = false;
            if (r.status === 429) { msg.textContent = "Too many tries. Wait 15 minutes."; msg.style.color = "var(--o-amber)"; return; }
            if (!r.ok) { msg.textContent = "That code isn't right. Check it and try again."; msg.style.color = "var(--o-amber)"; return; }
            CLOUD.token = v; saveCloud();
            live().forEach(function (o) { CLOUD.pending[o.id] = 1; });
            runSync();
            alert("Cloud backup is on. Your orders will save themselves from now on.");
            go("#/");
          })
          .catch(function () {
            tb.disabled = false;
            msg.textContent = "No internet right now — try again when you're back online.";
            msg.style.color = "var(--o-amber)";
          });
      };
      cc.appendChild(tb);
      cc.appendChild(el("div", "ohint", "Don't know your code? Ask Jordan — he can also turn it on for you with one tap."));
    }
    root.appendChild(cc);

    var c1 = el("div", "ocard");
    c1.appendChild(el("h3", null, "Save a copy"));
    c1.appendChild(el("p", null, "This saves all your orders into one file. Save it to Files → iCloud Drive. Do this once a week."));
    var b1 = el("button", "obtn obtn-primary", "💾 SAVE MY ORDERS");
    b1.onclick = doBackup;
    c1.appendChild(b1);
    if (DB.meta.lastBackupAt) c1.appendChild(el("div", "ohint", "Last saved " + fmtLong(DB.meta.lastBackupAt.slice(0, 10))));
    root.appendChild(c1);

    var c2 = el("div", "ocard");
    c2.appendChild(el("h3", null, "Open a backup file"));
    c2.appendChild(el("p", null, "This puts orders from a saved file back into the app."));
    var fi = el("input"); fi.type = "file"; fi.accept = "application/json,.json";
    fi.style.cssText = "margin-top:10px;font-size:17px";
    fi.onchange = function () {
      var f = fi.files && fi.files[0]; if (!f) return;
      f.text().then(function (txt) {
        var data;
        try { data = JSON.parse(txt); } catch (e) { alert("That file could not be read."); return; }
        if (!data || !Array.isArray(data.orders)) { alert("That doesn't look like a Blossoms backup."); return; }
        var incoming = data.orders.length, have = live().length;
        if (!confirm("This file has " + incoming + " orders. You currently have " + have + ".\n\nAdd them to what you have? (Nothing will be deleted.)")) return;
        snapshot();
        var byId = {};
        DB.orders.forEach(function (o) { byId[o.id] = o; });
        data.orders.forEach(function (o) {
          var cur = byId[o.id];
          if (!cur || (o.updatedAt || "") > (cur.updatedAt || "")) {
            if (cur) { for (var i = 0; i < DB.orders.length; i++) if (DB.orders[i].id === o.id) DB.orders[i] = o; }
            else DB.orders.push(o);
          }
        });
        persist();
        // a backup can carry the pictures too — put them back in the photo store
        var pd = data.photoData || {};
        var ids = Object.keys(pd);
        if (!ids.length) { alert("Done. You now have " + live().length + " orders."); go("#/"); return; }
        var done = 0;
        ids.reduce(function (chain, id) {
          return chain.then(function () {
            var rec = pd[id];
            return dataURLtoBlob(rec.full).then(function (fb) {
              return idbPut("photos", { id: id, blob: fb, w: rec.w || 0, h: rec.h || 0, bytes: fb.size, type: fb.type })
                .then(function () { return dataURLtoBlob(rec.thumb || rec.full); })
                .then(function (tb) { return idbPut("thumbs", { id: id, blob: tb, w: 0, h: 0 }); })
                .then(function () { done++; });
            }).catch(function (e) { console.warn("photo restore failed", id, e); });
          });
        }, Promise.resolve()).then(function () {
          alert("Done. You now have " + live().length + " orders and " + done + " photos.");
          go("#/");
        });
      });
    };
    c2.appendChild(fi);
    root.appendChild(c2);

    var cR = el("div", "ocard");
    cR.appendChild(el("h3", null, "Go back to an earlier version"));
    cR.appendChild(el("p", null, "Every time you save an order, this app keeps a copy. If something ever looks wrong, you can go back."));
    var rlist = el("div"); rlist.style.marginTop = "10px";
    cR.appendChild(rlist);
    idbAll("safety").then(function (rows) {
      var snaps = rows.filter(function (r) { return /^snap-/.test(r.k); })
        .sort(function (a, b) { return a.k < b.k ? 1 : -1; }).slice(0, 12);
      if (!snaps.length) { rlist.appendChild(el("div", "ohint", "No copies yet.")); return; }
      snaps.forEach(function (s) {
        var n = 0;
        try { n = JSON.parse(s.json).orders.filter(function (o) { return !o.deletedAt; }).length; } catch (e) { }
        var d = new Date(s.at);
        var b = el("button", "obtn obtn-plain");
        b.textContent = "↩︎ " + d.toLocaleString() + " — " + n + " orders";
        b.style.fontSize = "16px";
        b.onclick = function () {
          if (!confirm("Go back to the copy from " + d.toLocaleString() + "?\n\nIt has " + n + " orders. Your current list will be saved as another copy first.")) return;
          snapshot();
          mirror(JSON.stringify(DB)); // keep "now" recoverable too
          try {
            DB = JSON.parse(s.json);
            localStorage.setItem(K_ORDERS, s.json);
            alert("Done. You now have " + live().length + " orders.");
            go("#/");
          } catch (e) { alert("That copy could not be read."); }
        };
        rlist.appendChild(b);
      });
    });
    root.appendChild(cR);

    var c3 = el("div", "ocard");
    c3.appendChild(el("h3", null, "Storage"));
    var st = el("p", null, "Checking…");
    c3.appendChild(st);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        st.textContent = "Photos and orders are using " + Math.round((e.usage || 0) / 1048576) + " MB of about " + Math.round((e.quota || 0) / 1048576) + " MB.";
      }).catch(function () { st.textContent = "—"; });
    } else st.textContent = "—";
    root.appendChild(c3);

    var c4 = el("div", "ocard");
    c4.appendChild(el("h3", null, "Read me first"));
    var ul = el("ul", "ohelp");
    [
      "Everything is saved on this device only. There is no account and nothing syncs.",
      "Always open Blossoms from the flower icon on your Home Screen — not from Safari.",
      "Don't delete the Home Screen icon. That deletes your orders.",
      "Tap SAVE MY ORDERS once a week and save it to iCloud Drive.",
      "Photos are not in the backup file — keep the Instagram and email messages like you do now."
    ].forEach(function (t) { ul.appendChild(el("li", null, t)); });
    c4.appendChild(ul);
    root.appendChild(c4);
  }

  /* ================= SAVED INVOICES =================
     The invoice screen is a closed IIFE, so we read and write it through the DOM
     (same approach as the order handoff). Every keystroke autosaves, so an invoice
     can be reopened and changed instead of rebuilt from scratch. */
  var K_INV = "blossoms.invoices.v1";
  var INV = { list: [], currentId: null };

  function loadInvoices() {
    try {
      var raw = JSON.parse(localStorage.getItem(K_INV) || "null");
      if (raw && Array.isArray(raw.invoices)) INV.list = raw.invoices;
    } catch (e) { }
  }
  function saveInvoices() {
    try { localStorage.setItem(K_INV, JSON.stringify({ v: 1, invoices: INV.list })); } catch (e) { }
    mirror(JSON.stringify({ v: 1, invoices: INV.list, kind: "invoices" }));  // ride the same fail-safe
  }
  function liveInvoices() {
    return INV.list.filter(function (i) { return !i.deletedAt; })
      .sort(function (a, b) { return (b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1; });
  }
  function getInvoice(id) { for (var i = 0; i < INV.list.length; i++) if (INV.list[i].id === id) return INV.list[i]; return null; }

  function ival(id) { var e = $(id); return e ? e.value : ""; }
  function readInvoiceForm() {
    var items = [];
    document.querySelectorAll("#items .item").forEach(function (it) {
      var d = it.querySelector(".idesc"), p = it.querySelector(".iprice");
      if (!d || !p) return;
      if (d.value.trim() || p.value.trim()) items.push({ desc: d.value, price: p.value });
    });
    var sp = $("segPickup"), sd = $("segDelivery");
    return {
      date: ival("deliveryDate"), billTo: ival("billTo"),
      fulfillment: (sp && sp.classList.contains("active")) ? "pickup"
        : (sd && sd.classList.contains("active")) ? "delivery" : "",
      address: ival("addrFull"), items: items, deposit: ival("deposit"),
      payDepTerms: ival("payDepTerms"), payRemainder: ival("payRemainder"),
      payVenmo: ival("payVenmo"), payZelle: ival("payZelle"), payCard: ival("payCard"),
      sigName: ival("sigName"), sigEmail: ival("sigEmail"), sigPhone: ival("sigPhone")
    };
  }
  function invoiceIsEmpty(f) {
    return !f.billTo.trim() && !f.items.length;
  }
  function invoiceTotalCents(f) {
    return (f.items || []).reduce(function (a, it) { return a + (parseMoney(it.price) || 0); }, 0);
  }

  function writeInvoiceForm(f) {
    invLoading = true;
    setVal("deliveryDate", f.date || todayISO());
    setVal("billTo", f.billTo || "");
    if (f.fulfillment === "pickup") { var sp = $("segPickup"); if (sp) sp.click(); }
    else if (f.fulfillment === "delivery") {
      var sd = $("segDelivery"); if (sd) sd.click();
      if (f.address) setVal("addrFull", f.address);
    }
    // make sure there are enough item rows, then fill them (extras are blanked, and
    // the invoice's own code ignores blank rows)
    var want = Math.max(1, (f.items || []).length);
    var addBtn = $("addItem");
    var guard = 0;
    while (document.querySelectorAll("#items .item").length < want && guard++ < 40) addBtn.click();
    var rows = document.querySelectorAll("#items .item");
    for (var i = 0; i < rows.length; i++) {
      var it = (f.items || [])[i] || { desc: "", price: "" };
      var d = rows[i].querySelector(".idesc"), p = rows[i].querySelector(".iprice");
      if (d) { d.value = it.desc; d.dispatchEvent(new Event("input", { bubbles: true })); }
      if (p) { p.value = it.price; p.dispatchEvent(new Event("input", { bubbles: true })); }
    }
    setVal("deposit", f.deposit || "");
    ["payDepTerms", "payRemainder", "payVenmo", "payZelle", "payCard", "sigName", "sigEmail", "sigPhone"]
      .forEach(function (k) { if (f[k] != null && f[k] !== "") setVal(k, f[k]); });
    invLoading = false;
  }

  var invLoading = false, invSaveTimer = null;
  function autosaveInvoice() {
    if (invLoading) return;
    if (!invoiceScreen || invoiceScreen.hidden) return;
    var f = readInvoiceForm();
    if (invoiceIsEmpty(f) && !INV.currentId) return;      // nothing worth keeping yet
    var rec = INV.currentId ? getInvoice(INV.currentId) : null;
    if (!rec) {
      rec = { id: uuid(), createdAt: nowISO(), deletedAt: null, pdfAt: null, orderId: invoiceFrom || null };
      INV.list.push(rec);
      INV.currentId = rec.id;
    }
    Object.assign(rec, f);
    rec.updatedAt = nowISO();
    rec.totalCents = invoiceTotalCents(f);
    saveInvoices();
  }
  function scheduleInvoiceSave() {
    clearTimeout(invSaveTimer);
    invSaveTimer = setTimeout(autosaveInvoice, 700);
  }
  // one listener on the whole invoice screen catches every field
  document.addEventListener("input", function (e) {
    if (!invoiceScreen || invoiceScreen.hidden) return;
    if (e.target && e.target.closest && e.target.closest("#screen-invoice")) scheduleInvoiceSave();
  }, true);
  document.addEventListener("click", function (e) {
    if (!invoiceScreen || invoiceScreen.hidden) return;
    if (e.target && e.target.closest && e.target.closest("#segPickup,#segDelivery,#addItem,.item .rm")) scheduleInvoiceSave();
  }, true);

  /* ---- the saved-invoice list ---- */
  function renderInvoices() {
    root.appendChild(topbar("Back", "#/"));
    root.appendChild(el("h2", null, "My Invoices"));

    var list = liveInvoices();
    if (!list.length) {
      var e0 = el("div", "oempty");
      e0.appendChild(el("h3", null, "No invoices yet"));
      e0.appendChild(el("p", null, "Every invoice you make is kept here, so you can open it again and change it."));
      var nb = el("button", "obtn obtn-primary", "📄 Make an Invoice");
      nb.onclick = function () { INV.currentId = null; go("#/invoice?new=1"); };
      e0.appendChild(nb);
      root.appendChild(e0);
      return;
    }

    var nb2 = el("button", "obtn obtn-primary", "📄 Make a new Invoice");
    nb2.onclick = function () { INV.currentId = null; go("#/invoice?new=1"); };
    root.appendChild(nb2);

    list.forEach(function (inv) {
      var card = el("div", "orow");
      var rail = el("div", "orail");
      var d = dateOf(inv.date);
      rail.appendChild(el("div", "odow", d ? DOW[d.getDay()].toUpperCase() : ""));
      rail.appendChild(el("div", "oday", d ? String(d.getDate()) : "—"));
      card.appendChild(rail);

      var body = el("div", "obody");
      body.appendChild(el("div", "oname", inv.billTo || "No name"));
      var what = (inv.items && inv.items[0] && inv.items[0].desc || "").replace(/\s+/g, " ").trim();
      body.appendChild(el("div", "owhat", what ? (what.length > 52 ? what.slice(0, 52) + "…" : what) : "—"));
      var meta = el("div", "ometa");
      if (inv.totalCents) meta.appendChild(el("span", "ototal", money(inv.totalCents)));
      meta.appendChild(el("span", null, inv.pdfAt ? "Sent " + fmtShort(inv.pdfAt.slice(0, 10)) : "Not sent yet"));
      body.appendChild(meta);
      card.appendChild(body);

      card.onclick = function () { go("#/invoice?inv=" + inv.id); };
      root.appendChild(card);

      var del = el("button", "obtn obtn-danger", "🗑️ Delete this invoice");
      del.style.marginTop = "-4px";
      del.onclick = function (ev) {
        ev.stopPropagation();
        if (!confirm("Delete the invoice for " + (inv.billTo || "this customer") + "?")) return;
        inv.deletedAt = nowISO(); saveInvoices(); router();
      };
      root.appendChild(del);
    });
  }

  /* ================= CLOUD SYNC =================
     Local-first: the device stays the fast copy and never blocks on the network.
     Every change queues a push; every open pulls. Merge is last-write-wins per
     order using the order's own updatedAt, which the server enforces too.

     The token is NOT in this repo. It arrives once via a setup link
     (?cloud=<token>), is saved to localStorage, and stripped from the URL. */
  var K_CLOUD = "blossoms.cloud.v1";
  // Cloud backup is ALWAYS on — every device (phone home-screen, Safari, Mac)
  // connects with no setup. Jordan chose this over privacy for the business.
  var DEFAULT_CLOUD_CODE = "blossoms2026";
  var CLOUD = {
    url: "https://blossoms-sync-892609853582.us-east1.run.app",
    token: null,
    lastPullAt: null,
    state: "off",        // off | syncing | ok | offline | error
    pending: {},         // order ids waiting to go up
    suppress: false      // true while applying server data, so we don't echo it back
  };

  function loadCloud() {
    try {
      var c = JSON.parse(localStorage.getItem(K_CLOUD) || "null");
      if (c && c.token) { CLOUD.token = c.token; CLOUD.lastPullAt = c.lastPullAt || null; }
    } catch (e) { }
    // a setup link can still override with a full token: ?cloud=<token>
    try {
      var m = /[?&]cloud=([A-Za-z0-9_\-]{8,})/.exec(location.search || "");
      if (m) {
        CLOUD.token = m[1];
        history.replaceState(null, "", location.pathname + location.hash);
      }
    } catch (e) { }
    // No token on this device yet? Use the built-in one so it connects on its own.
    if (!CLOUD.token) CLOUD.token = DEFAULT_CLOUD_CODE;
    saveCloud();
    CLOUD.state = CLOUD.token ? "syncing" : "off";
  }
  function saveCloud() {
    try { localStorage.setItem(K_CLOUD, JSON.stringify({ token: CLOUD.token, lastPullAt: CLOUD.lastPullAt })); } catch (e) { }
  }
  function cloudOn() { return !!CLOUD.token; }
  function cloudHeaders() { return { "Authorization": "Bearer " + CLOUD.token, "Content-Type": "application/json" }; }

  function setSyncState(s) {
    if (CLOUD.state === s) return;
    CLOUD.state = s;
    paintSyncLine();
  }
  function paintSyncLine() {
    var el2 = $("osync");
    if (!el2) return;
    var n = Object.keys(CLOUD.pending).length;
    var map = {
      off: ["", ""],
      syncing: ["osync-work", n ? "Saving " + n + " change" + (n === 1 ? "" : "s") + "…" : "Saving…"],
      ok: ["osync-ok", "Saved to the cloud ✓"],
      offline: ["osync-warn", "No internet — saved on this phone, will send when you're back"],
      error: ["osync-warn", "Couldn't reach the cloud — your orders are safe on this phone"]
    };
    var m = map[CLOUD.state] || map.off;
    el2.className = "osync " + m[0];
    el2.textContent = m[1];
    el2.style.display = m[1] ? "" : "none";
  }

  /* ---- merge server -> local ---- */
  function mergeIncoming(list) {
    var changed = 0;
    (list || []).forEach(function (inc) {
      if (!inc || !inc.id) return;
      var found = -1;
      for (var i = 0; i < DB.orders.length; i++) if (DB.orders[i].id === inc.id) { found = i; break; }
      if (found < 0) { DB.orders.push(inc); changed++; return; }
      // only take the server's copy if it is genuinely newer
      if (String(inc.updatedAt || "") > String(DB.orders[found].updatedAt || "")) {
        DB.orders[found] = inc; changed++;
      }
    });
    if (changed) {
      CLOUD.suppress = true;          // applying server data must not re-queue a push
      persist(false);
      CLOUD.suppress = false;
    }
    return changed;
  }

  var didFullPull = false;
  function cloudPull() {
    if (!cloudOn()) return Promise.resolve(0);
    // The FIRST pull after the app loads ignores `since` and grabs everything.
    // This self-heals the case where records were added to the cloud with an
    // older timestamp than this device's last pull (an incremental pull skips those).
    var full = !didFullPull;
    didFullPull = true;
    var u = CLOUD.url + "/api/orders" + ((!full && CLOUD.lastPullAt) ? "?since=" + encodeURIComponent(CLOUD.lastPullAt) : "");
    return fetch(u, { headers: cloudHeaders() })
      .then(function (r) { if (!r.ok) throw new Error("pull " + r.status); return r.json(); })
      .then(function (d) {
        var n = mergeIncoming(d.orders);
        CLOUD.lastPullAt = d.serverTime || CLOUD.lastPullAt;
        saveCloud();
        if (n) router();
        return n;
      });
  }

  function cloudPush() {
    if (!cloudOn()) return Promise.resolve(0);
    var ids = Object.keys(CLOUD.pending);
    if (!ids.length) return Promise.resolve(0);
    var batch = ids.map(getOrder).filter(Boolean);
    if (!batch.length) { CLOUD.pending = {}; return Promise.resolve(0); }
    return fetch(CLOUD.url + "/api/orders", {
      method: "POST", headers: cloudHeaders(), body: JSON.stringify({ orders: batch })
    }).then(function (r) { if (!r.ok) throw new Error("push " + r.status); return r.json(); })
      .then(function (d) {
        // only clear what we actually sent; anything edited mid-flight stays queued
        batch.forEach(function (o) {
          var cur = getOrder(o.id);
          if (cur && String(cur.updatedAt) === String(o.updatedAt)) delete CLOUD.pending[o.id];
        });
        return d.written || 0;
      });
  }

  /* ---- photos: upload what the cloud is missing, fetch what we lack ---- */
  function syncPhotos() {
    if (!cloudOn()) return Promise.resolve();
    var wanted = {};
    live().forEach(function (o) { (o.photos || []).forEach(function (id) { wanted[id] = true; }); });
    var ids = Object.keys(wanted);
    if (!ids.length) return Promise.resolve();
    return fetch(CLOUD.url + "/api/photo/missing", {
      method: "POST", headers: cloudHeaders(), body: JSON.stringify({ ids: ids })
    }).then(function (r) { return r.ok ? r.json() : { missing: [] }; })
      .then(function (d) {
        var missing = d.missing || [];
        // 1) anything the cloud lacks but we hold -> upload
        return missing.reduce(function (chain, id) {
          return chain.then(function () {
            return idbGet("photos", id).then(function (p) {
              if (!p || !p.blob) return;                       // we don't have it either
              return blobToDataURL(p.blob).then(function (durl) {
                return fetch(CLOUD.url + "/api/photo", {
                  method: "POST", headers: cloudHeaders(), body: JSON.stringify({ id: id, dataUrl: durl })
                });
              });
            }).catch(function () { });
          });
        }, Promise.resolve()).then(function () {
          // 2) anything an order references that this device lacks -> download
          var haveCloud = ids.filter(function (id) { return missing.indexOf(id) < 0; });
          return haveCloud.reduce(function (chain, id) {
            return chain.then(function () {
              return idbGet("photos", id).then(function (p) {
                if (p && p.blob) return;                       // already local
                return fetch(CLOUD.url + "/api/photo/" + id, { headers: { "Authorization": "Bearer " + CLOUD.token } })
                  .then(function (r) { if (!r.ok) throw new Error("no photo"); return r.blob(); })
                  .then(function (b) {
                    return idbPut("photos", { id: id, blob: b, w: 0, h: 0, bytes: b.size, type: b.type })
                      .then(function () { return decode(b); })
                      .then(function (bmp) { return scaleTo(bmp, 320, 0.7); })
                      .then(function (t) { return idbPut("thumbs", { id: id, blob: t.blob, w: t.w, h: t.h }); });
                  }).catch(function () { });
              });
            });
          }, Promise.resolve());
        });
      }).catch(function () { });
  }

  /* ---- orchestration ---- */
  var syncTimer = null, backoff = 2000;
  function markDirty(id) {
    if (!cloudOn() || CLOUD.suppress) return;
    if (id) CLOUD.pending[id] = 1;
    scheduleSync();
  }
  function scheduleSync() {
    if (!cloudOn()) return;
    setSyncState("syncing");
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 1200);
  }
  function runSync() {
    if (!cloudOn()) return;
    if (!navigator.onLine) { setSyncState("offline"); return; }
    setSyncState("syncing");
    cloudPush()
      .then(cloudPull)
      .then(syncPhotos)
      .then(function () {
        backoff = 2000;
        setSyncState(Object.keys(CLOUD.pending).length ? "syncing" : "ok");
        if (Object.keys(CLOUD.pending).length) scheduleSync();
      })
      .catch(function (e) {
        console.warn("sync failed", e);
        setSyncState(navigator.onLine ? "error" : "offline");
        // retry with backoff — her order is already safe locally
        backoff = Math.min(backoff * 2, 60000);
        clearTimeout(syncTimer);
        syncTimer = setTimeout(runSync, backoff);
      });
  }
  window.addEventListener("online", function () { backoff = 2000; scheduleSync(); });
  window.addEventListener("offline", function () { setSyncState("offline"); });

  /* ================= web-app gestures =================
     Navigation only. Deliberately NO swipe-to-delete or swipe-to-complete —
     one stray swipe wrecking an order would cost more trust than it saves taps. */

  // where "back" goes from any screen (deterministic, no history surprises)
  function parentRoute() {
    var h = location.hash.replace(/^#/, "") || "/";
    var q = h.indexOf("?"); if (q >= 0) h = h.slice(0, q);
    var p = h.split("/").filter(Boolean);
    if (!p.length) return null;                         // already home
    if (p[0] === "edit" && p[1]) return "#/order/" + p[1];
    if (p[0] === "order") return "#/orders";
    if (p[0] === "orders" && p[1]) return "#/orders";   // calendar -> list
    return "#/";
  }
  function activeScreen() {
    return (invoiceScreen && !invoiceScreen.hidden) ? invoiceScreen : root;
  }

  var SW = { x: 0, y: 0, on: false, dir: null, screen: null };
  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { SW.on = false; return; }
    var t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,.olightbox")) { SW.on = false; return; }
    SW.x = e.touches[0].clientX; SW.y = e.touches[0].clientY;
    SW.on = !!parentRoute(); SW.dir = null; SW.screen = activeScreen();
  }, { passive: true });

  document.addEventListener("touchmove", function (e) {
    if (!SW.on || e.touches.length !== 1) return;
    var dx = e.touches[0].clientX - SW.x, dy = e.touches[0].clientY - SW.y;
    if (!SW.dir) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      SW.dir = Math.abs(dx) > Math.abs(dy) * 1.4 ? "h" : "v";
    }
    if (SW.dir !== "h") return;
    if (e.cancelable) e.preventDefault();               // we own this gesture now
    // a little rubber-banded peek so it feels attached to the finger
    var peek = Math.sign(dx) * Math.min(Math.abs(dx) * 0.4, 90);
    SW.screen.style.transition = "none";
    SW.screen.style.transform = "translateX(" + peek + "px)";
  }, { passive: false });

  function endSwipe(e) {
    if (!SW.on) return;
    var scr = SW.screen; SW.on = false;
    if (!scr) return;
    scr.style.transition = "transform .18s ease";
    scr.style.transform = "";
    if (SW.dir !== "h") return;
    var t = e.changedTouches && e.changedTouches[0]; if (!t) return;
    var dx = t.clientX - SW.x, dy = t.clientY - SW.y;
    // either direction goes back: left-edge drag right (iOS habit) or a leftward flick
    if (Math.abs(dy) > 60 || Math.abs(dx) < 70) return;
    var target = parentRoute();
    if (target) go(target);
  }
  document.addEventListener("touchend", endSwipe, { passive: true });
  function resetGestures() {
    if (SW.screen) { SW.screen.style.transition = "transform .18s ease"; SW.screen.style.transform = ""; }
    SW.on = false;
    PTR.on = false; PTR.d = 0;
    if (ptrEl) { ptrEl.classList.remove("show", "spinning"); ptrEl.style.transform = ""; ptrTxt.textContent = "Pull to refresh"; }
  }
  // an interrupted touch (call, notification, gesture steal) must not leave the UI stuck
  document.addEventListener("touchcancel", resetGestures, { passive: true });
  window.addEventListener("blur", resetGestures);
  document.addEventListener("visibilitychange", function () { if (document.hidden) resetGestures(); });

  /* ---- pull down to refresh ---- */
  var ptrEl = el("div", "optr");
  ptrEl.appendChild(el("div", "ospin"));
  var ptrTxt = el("span", null, "Pull to refresh");
  ptrEl.appendChild(ptrTxt);
  document.body.appendChild(ptrEl);

  var PTR = { y: 0, on: false, d: 0 };
  var PTR_TRIGGER = 78;
  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { PTR.on = false; return; }
    if (window.scrollY > 2) { PTR.on = false; return; }
    var t = e.target;
    if (t && t.closest && t.closest("input,textarea,.olightbox")) { PTR.on = false; return; }
    PTR.y = e.touches[0].clientY; PTR.on = true; PTR.d = 0;
  }, { passive: true });

  document.addEventListener("touchmove", function (e) {
    if (!PTR.on || e.touches.length !== 1) return;
    if (SW.dir === "h") { PTR.on = false; ptrEl.classList.remove("show"); return; }
    var d = e.touches[0].clientY - PTR.y;
    if (d <= 0 || window.scrollY > 2) {
      PTR.on = false; ptrEl.classList.remove("show"); ptrEl.style.transform = ""; return;
    }
    if (e.cancelable) e.preventDefault();               // stop the page rubber-banding
    PTR.d = Math.min(d, 150);
    ptrEl.classList.add("show");
    ptrEl.style.transform = "translateY(" + (PTR.d * 0.7) + "px)";
    ptrTxt.textContent = PTR.d > PTR_TRIGGER ? "Let go to refresh" : "Pull to refresh";
  }, { passive: false });

  document.addEventListener("touchend", function () {
    if (!PTR.on) return;
    PTR.on = false;
    if (PTR.d > PTR_TRIGGER) {
      ptrTxt.textContent = "Refreshing…";
      ptrEl.classList.add("spinning");
      // a real reload, so a refresh also picks up a newer version of the app
      setTimeout(function () { location.reload(); }, 320);
    } else {
      ptrEl.classList.remove("show");
      ptrEl.style.transform = "";
    }
  }, { passive: true });

  /* ================= boot ================= */
  load();
  loadInvoices();
  loadCloud();
  // Carry her existing orders over from her Notes, once per device.
  // Keyed on its own marker (not everHadOrders) so a device that already visited
  // the app while it was empty still gets them.
  if (!DB.meta.seedV1 && !live().length && window.BLOSSOMS_SEED) {
    try {
      DB.orders = DB.orders.concat(JSON.parse(JSON.stringify(window.BLOSSOMS_SEED)));
      DB.meta.seedV1 = true;
      persist(false);
    } catch (e) { console.warn("seed failed", e); }
  }
  // Devices seeded before the photos existed still need them attached.
  // Matches on date + name, and never touches an order she has added photos to herself.
  if (!DB.meta.photosV1 && window.BLOSSOMS_SEED) {
    try {
      var byKey = {};
      window.BLOSSOMS_SEED.forEach(function (s) {
        if ((s.thumbUrls || []).length) byKey[s.eventDate + "|" + s.name] = s;
      });
      var patched = 0;
      DB.orders.forEach(function (o) {
        var s = byKey[o.eventDate + "|" + o.name];
        if (!s) return;
        if ((o.thumbUrls || []).length || (o.photos || []).length) return;
        o.photoUrls = s.photoUrls.slice();
        o.thumbUrls = s.thumbUrls.slice();
        patched++;
      });
      DB.meta.photosV1 = true;
      persist(false);
      if (patched) console.log("attached photos to " + patched + " existing orders");
    } catch (e) { console.warn("photo backfill failed", e); }
  }
  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) { } }
  window.addEventListener("hashchange", function () { router(); });
  router();
  bootRecover().then(function () { if (!location.hash || location.hash === "#/") router(); });

  // first sync on open: everything already saved locally goes up, anything new comes down
  if (cloudOn()) {
    live().forEach(function (o) { CLOUD.pending[o.id] = 1; });
    setTimeout(runSync, 600);
  }

  // expose a tiny surface for testing only
  window.BlossomsOrders = {
    _db: function () { return DB; },
    _parse: parseNote,
    _stats: monthStats,
    _seed: function (arr) { DB.orders = arr; persist(false); router(); }
  };
})();
