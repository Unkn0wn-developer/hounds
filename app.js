"use strict";

/* ============================================================
   CONFIG — the only block you normally need to edit
   ============================================================ */
const CONFIG = {
  // Change this to your Cloudflare Worker URL if the browser reports a CORS error.
  API_BASE: "https://api2.warera.io/trpc",
  MU_ID: "6a38b3d650c0950afbe93b0d",
  MU_NAME: "GreyHounds",
  REFRESH_SECONDS: 30,
  BATCH_SIZE: 25,
  MIN_HEALTH_TO_FIGHT: 10,
  ONLINE_WITHIN_MINUTES: 10,
};

const ROLE_RANK = { owner: 0, manager: 1, commander: 2, member: 3 };
const ROLE_LABEL = { owner: "Owner", manager: "Manager", commander: "Commander", member: "Member" };
const BUFF_RANK = { buffed: 2, neutral: 1, debuffed: 0 };

/* ============================================================
   API
   ============================================================ */
async function httpJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) || "";
    throw new Error("HTTP " + res.status + (msg ? " - " + msg : ""));
  }
  return body;
}

function unwrap(entry) {
  if (entry && entry.error) throw new Error(entry.error.message || "API error");
  return entry && entry.result ? entry.result.data : undefined;
}

async function trpcGet(proc, input) {
  const url = CONFIG.API_BASE + "/" + proc + "?input=" + encodeURIComponent(JSON.stringify(input));
  return unwrap(await httpJson(url));
}

async function trpcBatch(proc, inputs) {
  const names = inputs.map(() => proc).join(",");
  const obj = {};
  inputs.forEach((inp, i) => { obj[i] = inp; });
  const url = CONFIG.API_BASE + "/" + names + "?batch=1&input=" + encodeURIComponent(JSON.stringify(obj));
  const body = await httpJson(url);
  if (!Array.isArray(body)) throw new Error("Unexpected batch response");
  return body.map((entry) => {
    try { return { ok: true, data: unwrap(entry) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

async function fetchMu() {
  try {
    const d = await trpcGet("mu.getById", { muId: CONFIG.MU_ID });
    if (d && d._id) return d;
  } catch (_) { /* fall back to search below */ }
  const d = await trpcGet("mu.getManyPaginated", { search: CONFIG.MU_NAME, limit: 20 });
  const mu = ((d && d.items) || []).find((m) => m._id === CONFIG.MU_ID);
  if (!mu) throw new Error("MU not found in API response");
  return mu;
}

async function fetchUserChunk(ids) {
  try {
    const out = await trpcBatch("user.getUserLite", ids.map((userId) => ({ userId })));
    if (out.length === ids.length) return out;
  } catch (_) { /* fall back to single requests */ }
  const settled = await Promise.allSettled(ids.map((userId) => trpcGet("user.getUserLite", { userId })));
  return settled.map((s) => s.status === "fulfilled"
    ? { ok: true, data: s.value }
    : { ok: false, error: String(s.reason && s.reason.message || s.reason) });
}

async function fetchUsers(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += CONFIG.BATCH_SIZE) chunks.push(ids.slice(i, i + CONFIG.BATCH_SIZE));
  const results = await Promise.all(chunks.map(fetchUserChunk));
  const map = new Map();
  chunks.forEach((chunk, ci) => chunk.forEach((id, i) => map.set(id, results[ci][i])));
  return map;
}

/* ============================================================
   Data -> row model (pure functions, no DOM)
   ============================================================ */
function roleOf(id, mu) {
  if (id === mu.user) return "owner";
  const roles = mu.roles || {};
  if ((roles.managers || []).includes(id)) return "manager";
  if ((roles.commanders || []).includes(id)) return "commander";
  return "member";
}

function barOf(skill) {
  if (!skill) return { cur: null, max: null, regen: null };
  const cur = typeof skill.currentBarValue === "number" ? skill.currentBarValue : null;
  const max = typeof skill.value === "number" ? skill.value : (typeof skill.total === "number" ? skill.total : null);
  return { cur, max, regen: typeof skill.hourlyBarRegen === "number" ? skill.hourlyBarRegen : null };
}

// buffed / debuffed / neutral, based on the attack skill's buff and debuff percentages.
function buffInfo(u) {
  const atk = (u.skills && u.skills.attack) || {};
  const buff = atk.buffsPercent || 0;
  const debuff = atk.debuffsPercent || 0;
  let state = "neutral";
  if (debuff > 0) state = "debuffed";
  else if (buff > 0) state = "buffed";

  let endAt = null;
  if (state === "buffed") endAt = (u.buffs && u.buffs.buffEndAt) || null;
  if (state === "debuffed") {
    endAt = (u.debuffs && (u.debuffs.debuffEndAt || u.debuffs.endAt))
      || (u.buffs && u.buffs.debuffEndAt)
      || null;
  }
  const codes = ((u.buffs && u.buffs.buffCodes) || []).slice();
  return { state, buff, debuff, endAt: endAt ? Date.parse(endAt) : null, codes };
}

function buildRow(id, result, mu) {
  const role = roleOf(id, mu);
  if (!result || !result.ok || !result.data) {
    return {
      id, role, roleRank: ROLE_RANK[role], failed: true,
      error: (result && result.error) || "no data",
      name: "Unknown (" + id.slice(-6) + ")",
      level: null, health: barOf(null), hunger: barOf(null), energy: barOf(null), stamina: barOf(null),
      buff: { state: "neutral", buff: 0, debuff: 0, endAt: null, codes: [] },
      attack: null, lastSeen: null, canFight: false, raw: null,
    };
  }
  const u = result.data;
  const sk = u.skills || {};
  const health = barOf(sk.health);
  return {
    id, role, roleRank: ROLE_RANK[role], failed: false,
    name: u.username || ("User " + id.slice(-6)),
    level: u.leveling ? u.leveling.level : null,
    health,
    hunger: barOf(sk.hunger),
    energy: barOf(sk.energy),
    stamina: barOf(sk.stamina),
    buff: buffInfo(u),
    attack: sk.attack ? sk.attack.total : null,
    lastSeen: u.dates && u.dates.lastConnectionAt ? Date.parse(u.dates.lastConnectionAt) : null,
    canFight: health.cur != null && health.cur >= CONFIG.MIN_HEALTH_TO_FIGHT,
    raw: u,
  };
}

/* ============================================================
   Formatting helpers
   ============================================================ */
function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function relAgo(ts, now) {
  if (ts == null) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const hr = Math.floor(m / 60);
  if (hr < 48) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

function dur(ms) {
  if (ms <= 0) return "ended";
  const s = Math.floor(ms / 1000);
  const hr = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (hr > 0) return hr + "h " + m + "m";
  if (m > 0) return m + "m " + sec + "s";
  return sec + "s";
}

function isOnline(row, now) {
  return row.lastSeen != null && now - row.lastSeen <= CONFIG.ONLINE_WITHIN_MINUTES * 60000;
}

/* ============================================================
   DOM
   ============================================================ */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const state = {
  mu: null,
  rows: [],
  sortKey: "role",
  sortDir: 1,
  filterText: "",
  filterStatus: "all",
  expanded: new Set(),
  paused: false,
  loading: false,
  lastUpdated: null,
  nextAt: 0,
  error: null,
};

const SORTERS = {
  member: (r) => r.name.toLowerCase(),
  role: (r) => r.roleRank,
  level: (r) => r.level,
  health: (r) => r.health.cur,
  hunger: (r) => r.hunger.cur,
  energy: (r) => r.energy.cur,
  stamina: (r) => r.stamina.cur,
  buff: (r) => BUFF_RANK[r.buff.state],
  attack: (r) => r.attack,
  seen: (r) => r.lastSeen,
  fight: (r) => (r.canFight ? 1 : 0),
};

function visibleRows(now) {
  const q = state.filterText.trim().toLowerCase();
  let rows = state.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  switch (state.filterStatus) {
    case "buffed": case "neutral": case "debuffed":
      rows = rows.filter((r) => r.buff.state === state.filterStatus); break;
    case "cannot-fight": rows = rows.filter((r) => !r.failed && !r.canFight); break;
    case "no-food": rows = rows.filter((r) => r.hunger.cur === 0); break;
    case "online": rows = rows.filter((r) => isOnline(r, now)); break;
    default: break;
  }
  const get = SORTERS[state.sortKey] || SORTERS.role;
  rows = rows.slice().sort((a, b) => {
    let x = get(a), y = get(b);
    if (x == null) x = -Infinity;
    if (y == null) y = -Infinity;
    let c;
    if (typeof x === "string" && typeof y === "string") c = x.localeCompare(y);
    else c = x === y ? 0 : (x < y ? -1 : 1);
    if (c === 0) c = a.roleRank - b.roleRank || a.name.localeCompare(b.name);
    return c * state.sortDir;
  });
  return rows;
}

function barCell(b, kind) {
  const td = h("td");
  if (b.cur == null) { td.textContent = "—"; return td; }
  const pct = b.max ? Math.max(0, Math.min(100, (b.cur / b.max) * 100)) : 0;
  let level = "ok";
  if (pct < 35) level = "warn";
  if (kind === "health" && b.cur < CONFIG.MIN_HEALTH_TO_FIGHT) level = "bad";
  if (kind === "hunger" && b.cur === 0) level = "bad";
  td.append(
    h("div", { class: "bar " + level }, h("span", { style: "width:" + pct.toFixed(1) + "%" })),
    h("div", { class: "barlabel" }, fmt(b.cur) + " / " + fmt(b.max))
  );
  return td;
}

function buffCell(row) {
  const b = row.buff;
  const td = h("td");
  const label = b.state === "buffed" ? "Buffed +" + b.buff + "%"
    : b.state === "debuffed" ? "Debuffed -" + b.debuff + "%"
    : "Neutral";
  td.append(h("span", { class: "badge " + b.state }, label));
  const extra = h("div", { class: "small" });
  if (b.endAt) {
    extra.append(document.createTextNode(b.state === "buffed" ? "ends in " : "ends in "));
    extra.append(h("span", { "data-end": String(b.endAt) }, dur(b.endAt - Date.now())));
  }
  if (b.codes.length) extra.append(document.createTextNode((b.endAt ? " · " : "") + b.codes.join(", ")));
  if (extra.childNodes.length) td.append(extra);
  return td;
}

function detailRow(row) {
  const u = row.raw;
  const tr = h("tr", { class: "detail" });
  const td = h("td", { colspan: "10" });
  if (!u) {
    td.textContent = "Could not load this member: " + row.error;
    tr.append(td);
    return tr;
  }
  const sk = u.skills || {};
  const atk = sk.attack || {};
  const pairs = [
    ["Attack total", fmt(atk.total)],
    ["Base attack skill", fmt(atk.value)],
    ["Weapon", fmt(atk.weapon)],
    ["Ammo bonus", atk.ammoPercent != null ? atk.ammoPercent + "%" : "—"],
    ["Buff bonus", (atk.buffsPercent || 0) + "%"],
    ["Debuff penalty", (atk.debuffsPercent || 0) + "%"],
    ["Rank bonus", atk.militaryRankPercent != null ? atk.militaryRankPercent + "%" : "—"],
    ["Military rank", u.militaryRank != null ? u.militaryRank : "—"],
    ["Crit chance", sk.criticalChance ? sk.criticalChance.total + "%" : "—"],
    ["Crit damage", sk.criticalDamages ? sk.criticalDamages.total + "%" : "—"],
    ["Precision", sk.precision ? sk.precision.total + "%" : "—"],
    ["Armor", sk.armor ? sk.armor.total + "%" : "—"],
    ["Dodge", sk.dodge ? sk.dodge.total + "%" : "—"],
    ["Loot chance", sk.lootChance ? sk.lootChance.total + "%" : "—"],
    ["Health regen / h", row.health.regen != null ? fmt(row.health.regen) : "—"],
    ["Hunger regen / h", row.hunger.regen != null ? fmt(row.hunger.regen) : "—"],
    ["Total damage", fmt(u.stats ? u.stats.damagesCount : null)],
    ["Total XP", fmt(u.leveling ? u.leveling.totalXp : null)],
    ["Wealth rank value", u.rankings && u.rankings.userWealth ? fmt(u.rankings.userWealth.value) : "—"],
    ["Damage rank", u.rankings && u.rankings.userDamages ? "#" + u.rankings.userDamages.rank : "—"],
  ];
  const grid = h("div", { class: "detailgrid" });
  pairs.forEach(([k, v]) => grid.append(h("div", {}, h("span", {}, k), String(v))));
  td.append(grid);
  tr.append(td);
  return tr;
}

function render() {
  const now = Date.now();

  if (state.mu) {
    const up = state.mu.activeUpgradeLevels || {};
    $("#muName").textContent = state.mu.name || CONFIG.MU_NAME;
    $("#muMeta").textContent = (state.mu.members || []).length + " members"
      + (up.headquarters != null ? " · HQ level " + up.headquarters : "")
      + (up.dormitories != null ? " · Dormitories " + up.dormitories : "");
  }

  const banner = $("#errorBanner");
  if (state.error) { banner.hidden = false; banner.textContent = state.error; }
  else banner.hidden = true;

  const rows = state.rows;
  const okRows = rows.filter((r) => !r.failed);
  const count = (fn) => okRows.filter(fn).length;
  const cards = [
    ["Members", rows.length],
    ["Online now", count((r) => isOnline(r, now))],
    ["Buffed", count((r) => r.buff.state === "buffed")],
    ["Neutral", count((r) => r.buff.state === "neutral")],
    ["Debuffed", count((r) => r.buff.state === "debuffed")],
    ["Can fight", count((r) => r.canFight)],
    ["Hunger empty", count((r) => r.hunger.cur === 0)],
  ];
  const summary = $("#summary");
  summary.replaceChildren(...cards.map(([l, v]) => h("div", { class: "card" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l))));

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.sortKey;
    th.classList.toggle("sorted", active);
    th.classList.toggle("desc", active && state.sortDir === -1);
  });

  const tbody = $("#rows");
  const frag = document.createDocumentFragment();
  for (const row of visibleRows(now)) {
    const tr = h("tr", {
      class: "row",
      onclick: () => {
        if (state.expanded.has(row.id)) state.expanded.delete(row.id); else state.expanded.add(row.id);
        render();
      },
    });
    tr.append(
      h("td", {},
        isOnline(row, now) ? h("span", { class: "online-dot", title: "Online" }) : null,
        h("span", { class: "name" }, row.name),
        h("span", { class: "role " + row.role }, ROLE_LABEL[row.role])),
      h("td", { class: "num" }, row.level != null ? row.level : "—"),
      barCell(row.health, "health"),
      barCell(row.hunger, "hunger"),
      barCell(row.energy, "energy"),
      barCell(row.stamina, "stamina"),
      buffCell(row),
      h("td", { class: "num" }, fmt(row.attack)),
      h("td", {}, h("span", { "data-seen": row.lastSeen != null ? String(row.lastSeen) : "" }, relAgo(row.lastSeen, now))),
      h("td", {}, row.failed
        ? h("span", { class: "badge no" }, "error")
        : h("span", { class: "badge " + (row.canFight ? "yes" : "no") }, row.canFight ? "Yes" : "No (HP)"))
    );
    frag.append(tr);
    if (state.expanded.has(row.id)) frag.append(detailRow(row));
  }
  tbody.replaceChildren(frag);
  updateStatus();
}

function $(sel) { return document.querySelector(sel); }

/* ============================================================
   Live updating
   ============================================================ */
function describeError(err) {
  if (err instanceof TypeError) {
    return "Could not reach the WarEra API from the browser. This is usually a CORS block or no internet. "
      + "If it is CORS, deploy worker.js and put its URL in API_BASE at the top of app.js.";
  }
  return "API error: " + (err && err.message ? err.message : String(err));
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  updateStatus();
  try {
    const mu = await fetchMu();
    const ids = mu.members || [];
    const results = await fetchUsers(ids);
    state.mu = mu;
    state.rows = ids.map((id) => buildRow(id, results.get(id), mu));
    state.lastUpdated = Date.now();
    state.error = null;
  } catch (err) {
    state.error = describeError(err);
  } finally {
    state.loading = false;
    state.nextAt = Date.now() + CONFIG.REFRESH_SECONDS * 1000;
    render();
  }
}

function updateStatus() {
  const el = $("#statusLine");
  if (!el) return;
  const now = Date.now();
  if (state.loading) { el.textContent = "Updating…"; return; }
  const parts = [];
  parts.push(state.lastUpdated ? "Updated " + Math.max(0, Math.round((now - state.lastUpdated) / 1000)) + "s ago" : "No data yet");
  parts.push(state.paused ? "auto-refresh paused" : "next refresh in " + Math.max(0, Math.ceil((state.nextAt - now) / 1000)) + "s");
  el.textContent = parts.join(" · ");
}

function tick() {
  const now = Date.now();
  document.querySelectorAll("[data-end]").forEach((el) => {
    el.textContent = dur(Number(el.dataset.end) - now);
  });
  document.querySelectorAll("[data-seen]").forEach((el) => {
    if (el.dataset.seen) el.textContent = relAgo(Number(el.dataset.seen), now);
  });
  updateStatus();
  if (!state.paused && !state.loading && state.nextAt && now >= state.nextAt) refresh();
}

function init() {
  $("#filterText").addEventListener("input", (e) => { state.filterText = e.target.value; render(); });
  $("#filterStatus").addEventListener("change", (e) => { state.filterStatus = e.target.value; render(); });
  $("#btnRefresh").addEventListener("click", () => refresh());
  $("#btnPause").addEventListener("click", (e) => {
    state.paused = !state.paused;
    e.target.textContent = state.paused ? "Resume" : "Pause";
    if (!state.paused) state.nextAt = Date.now();
    updateStatus();
  });
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = -state.sortDir;
      else { state.sortKey = key; state.sortDir = 1; }
      render();
    });
  });
  setInterval(tick, 1000);
  refresh();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildRow, buffInfo, roleOf, fmt, dur, relAgo };
} else {
  document.addEventListener("DOMContentLoaded", init);
}
