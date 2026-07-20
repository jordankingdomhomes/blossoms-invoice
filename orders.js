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
  }

  /* ================= derived money ================= */
  function grand(o) { return o.totalCents == null ? null : o.totalCents + (o.deliveryFeeCents || 0); }
  function paid(o) { return (o.payments || []).reduce(function (a, p) { return a + (p.cents || 0); }, 0); }
  function balance(o) { var g = grand(o); return g == null ? null : g - paid(o); }
  function isOverdue(o) { var b = balance(o); return b != null && b > 0 && o.eventDate < todayISO(); }

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

  // Money actually marked as received, all time. This is the "closed" number.
  function receivedAllTime() {
    return live().reduce(function (a, o) { return o.kind === "order" ? a + paid(o) : a; }, 0);
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
      mountInvoiceChrome(new URLSearchParams(q).get("from"));
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
    renderBackupBar();
    renderRecoveryCard();
    renderStandaloneBar();

    root.appendChild(buildHero());

    var bNew = el("button", "obtn obtn-primary obtn-xl", "➕  New Order");
    bNew.onclick = function () { go("#/new"); };
    root.appendChild(bNew);

    var bInv = el("button", "obtn obtn-secondary obtn-xl", "📄  Make an Invoice");
    bInv.onclick = function () { go("#/invoice"); };
    root.appendChild(bInv);

    var n = live().filter(function (o) { return o.kind === "order"; }).length;
    var bList = el("button", "obtn obtn-plain", "📋  See all my orders" + (n ? "  (" + n + ")" : ""));
    bList.onclick = function () { go("#/orders"); };
    root.appendChild(bList);

    var bMoney = el("button", "obtn obtn-plain", "💰  Money month by month");
    bMoney.onclick = function () { go("#/money"); };
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
      var txt = state.monthFilter ? "Showing " + monthLabel(state.monthFilter) + " only."
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
    var fb = futureBooked(), got = receivedAllTime(), oe = owedEverywhere();
    var box = el("div", "oticker ohero");

    var split = el("div", "ohero-split");

    // long money strings must shrink rather than clip
    function num(cents) {
      var txt = money(cents), n = el("div", "ohero-num", txt);
      var L = txt.length;
      n.style.fontSize = L > 10 ? "23px" : L > 8 ? "27px" : L > 6 ? "31px" : "34px";
      return n;
    }

    var a = el("div", "ohero-half");
    a.appendChild(el("div", "otick-label", "COMING UP"));
    a.appendChild(num(fb.value));
    a.appendChild(el("div", "ohero-sub", fb.count + " order" + (fb.count === 1 ? "" : "s") + " booked"));
    split.appendChild(a);

    var b = el("div", "ohero-half");
    b.appendChild(el("div", "otick-label", "RECEIVED"));
    b.appendChild(num(got));
    b.appendChild(el("div", "ohero-sub", "paid to you so far"));
    split.appendChild(b);

    box.appendChild(split);

    if (oe.total > 0) {
      var strip = el("div", "ostrip tappable");
      strip.appendChild(el("span", null, "💰 Still owed to you " + money(oe.total) + " across " + oe.count + " order" + (oe.count === 1 ? "" : "s")));
      strip.onclick = function () { state.filter = "owed"; state.monthFilter = null; go("#/orders"); };
      box.appendChild(strip);
    }
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

  function orderRow(o) {
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

    var what = (o.what || "").replace(/\s+/g, " ").trim();
    var w = el("div", "owhat" + (what ? "" : " empty"), what ? (what.length > 64 ? what.slice(0, 64) + "…" : what) : "⚠︎ Nothing written down yet");
    body.appendChild(w);

    var meta = el("div", "ometa");
    var chip = moneyChip(o);
    if (chip && !o.done) { var c = el("span", "ochip " + chip.cls, chip.text); meta.appendChild(c); }
    var bits = [];
    if (o.fulfillment === "pickup") bits.push("Pick up" + (o.eventTime ? " " + fmtTime(o.eventTime) : ""));
    if (o.fulfillment === "delivery") bits.push("Delivery");
    if (o.tentative) bits.push("not confirmed");
    if (bits.length) meta.appendChild(el("span", null, bits.join(" · ")));
    if (meta.childNodes.length) body.appendChild(meta);
    row.appendChild(body);

    if (o.photos && o.photos.length) {
      var img = el("img", "othumb"); img.alt = "";
      thumbURL(o.photos[0]).then(function (u) { if (u) img.src = u; });
      row.appendChild(img);
    }

    row.onclick = function () { go("#/order/" + o.id); };
    return row;
  }

  function emptyState() {
    var e = el("div", "oempty");
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

    root.appendChild(topbar("Back to my orders", "#/"));
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
  function renderForm2(o, isNew) { root.appendChild(topbar("Back to my orders", "#/")); root.appendChild(el("h2", null, isNew ? "New Order" : "Change this order")); renderFormInto(o, isNew); }

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

    function paintMoneyExtra() {
      moneyExtra.innerHTML = "";
      if (o.totalCents == null) return;
      var dw = el("div", "ofield");
      dw.appendChild(el("label", null, "Deposit (usually half)"));
      var w2 = el("div", "omoneywrap"); w2.appendChild(el("span", "odollar", "$")); w2.appendChild(depIn);
      dw.appendChild(w2);
      moneyExtra.appendChild(dw);

      var pf = el("div", "ofield");
      pf.appendChild(el("label", null, "Have they paid it?"));
      pf.appendChild(chipRow([
        { v: "none", label: "Not yet" }, { v: "deposit", label: "Deposit paid" }, { v: "full", label: "Paid in full" }
      ], payState, function (v) {
        payState = v;
        if (v === "full") depIn.value = (o.totalCents / 100).toString();
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

      var depC = parseMoney(depIn.value) || 0;
      var bal = (o.totalCents + (o.deliveryFeeCents || 0)) - (payState === "none" ? 0 : depC);
      moneyExtra.appendChild(el("div", "obalance", "Balance " + money(bal)));
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
      go("#/");
    };
    form.appendChild(save);

    if (!isNew) {
      var del = el("button", "obtn obtn-danger", "🗑️ Delete this order");
      del.onclick = function () {
        if (!confirm("Delete this order? It will be removed from your list.")) return;
        var real = getOrder(o.id);
        if (real) { real.deletedAt = nowISO(); persist(); }
        go("#/");
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
    if (!o) { go("#/"); return; }
    root.appendChild(topbar("Back to my orders", "#/"));
    var d = el("div", "odetail");

    d.appendChild(el("h2", null, (o.name || "No name yet")));
    var sub = fmtLong(o.eventDate) + (o.eventTime ? " · " + fmtTime(o.eventTime) : "");
    if (o.tentative) sub += "  (not confirmed)";
    d.appendChild(el("div", "osubtitle", sub));

    if (o.what) { var c1 = el("div", "ocard"); c1.appendChild(el("h3", null, "What they want")); c1.appendChild(el("p", null, o.what)); d.appendChild(c1); }
    if (o.avoid) { var c2 = el("div", "ocard avoid"); c2.appendChild(el("h3", null, "Avoid")); c2.appendChild(el("p", null, o.avoid)); d.appendChild(c2); }

    if (o.photos && o.photos.length) {
      var pc = el("div", "ocard");
      pc.appendChild(el("h3", null, "Photos"));
      var ps = el("div", "ophotos");
      o.photos.forEach(function (pid) {
        var cell = el("div", "ophoto");
        var img = el("img"); img.alt = "";
        thumbURL(pid).then(function (u) { if (u) img.src = u; });
        img.onclick = function () { openLightbox(pid); };
        cell.appendChild(img); ps.appendChild(cell);
      });
      pc.appendChild(ps); d.appendChild(pc);
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
        var r = el("div", "omoneyrow");
        r.appendChild(el("span", null, "Paid " + (p.method ? "(" + p.method + ")" : "")));
        r.appendChild(el("b", null, "− " + money(p.cents)));
        mc.appendChild(r);
      });
      var rb = el("div", "omoneyrow big");
      rb.appendChild(el("span", null, balance(o) <= 0 ? "Paid in full" : "Still owes you"));
      rb.appendChild(el("b", null, money(Math.max(0, balance(o)))));
      mc.appendChild(rb);
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
    if (t.closest("#makeBtn") && invoiceFrom) {
      var o = getOrder(invoiceFrom);
      if (o) { o.invoicedAt = nowISO(); upsert(o); }
    }
  }, true);

  /* ================= backup / settings ================= */
  function backupJSON() {
    var payload = JSON.parse(JSON.stringify(DB));
    payload.exportedAt = nowISO();
    payload.photoNote = "Photos are not included in this file.";
    return JSON.stringify(payload, null, 2);
  }
  function doBackup() {
    var name = "Blossoms-Orders-" + todayISO() + ".json";
    var blob = new Blob([backupJSON()], { type: "application/json" });
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
        alert("Done. You now have " + live().length + " orders.");
        go("#/");
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
  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) { } }
  window.addEventListener("hashchange", function () { router(); });
  router();
  bootRecover().then(function () { if (!location.hash || location.hash === "#/") router(); });

  // expose a tiny surface for testing only
  window.BlossomsOrders = {
    _db: function () { return DB; },
    _parse: parseNote,
    _stats: monthStats,
    _seed: function (arr) { DB.orders = arr; persist(false); router(); }
  };
})();
