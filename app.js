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
};

const ROLE_RANK = { owner: 0, manager: 1, commander: 2, member: 3 };
const ROLE_LABEL = { owner: "Owner", manager: "Manager", commander: "Commander", member: "Member" };
const ROLE_LETTER = { owner: "O", manager: "M", commander: "C" };
const BUFF_RANK = { buffed: 2, neutral: 1, debuffed: 0 };

/* Small inline icons (static strings, not user data) */
const ICONS = {
  heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  fork: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/></svg>',
  pill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8.5" width="20" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/><path d="M6 20l6-6 6 6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18 14.8c2 .6 3.3 2.3 3.5 5.2"/></svg>',
  hq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2"/></svg>',
  bed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18V6M3 14h18v4M21 14v-2a3 3 0 00-3-3h-7v5"/><circle cx="7" cy="11" r="1.5"/></svg>',
};

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
      level: null, health: barOf(null), hunger: barOf(null),
      buff: { state: "neutral", buff: 0, debuff: 0, endAt: null, codes: [] },
      damage: null, lastSeen: null, raw: null,
    };
  }
  const u = result.data;
  const sk = u.skills || {};
  return {
    id, role, roleRank: ROLE_RANK[role], failed: false,
    name: u.username || ("User " + id.slice(-6)),
    level: u.leveling ? u.leveling.level : null,
    health: barOf(sk.health),
    hunger: barOf(sk.hunger),
    buff: buffInfo(u),
    damage: u.stats && typeof u.stats.damagesCount === "number" ? u.stats.damagesCount : null,
    lastSeen: u.dates && u.dates.lastConnectionAt ? Date.parse(u.dates.lastConnectionAt) : null,
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

/* ============================================================
   DOM
   ============================================================ */
function $(sel) { return document.querySelector(sel); }

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

function icon(name) {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = ICONS[name] || ""; // static, trusted strings only
  return s;
}

function avatarEl(url, fallbackText, cls) {
  const wrap = h("span", { class: cls || "avatar" });
  const letter = (fallbackText || "?").trim().charAt(0).toUpperCase();
  if (typeof url === "string" && url.startsWith("https://")) {
    const img = h("img", { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => { img.remove(); wrap.textContent = letter; });
    wrap.append(img);
  } else {
    wrap.textContent = letter;
  }
  return wrap;
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
  health: (r) => r.health.cur,
  buff: (r) => BUFF_RANK[r.buff.state] * 1e14 + (r.buff.endAt || 0),
  damage: (r) => r.damage,
  seen: (r) => r.lastSeen,
};

function visibleRows() {
  const q = state.filterText.trim().toLowerCase();
  let rows = state.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  if (["buffed", "neutral", "debuffed"].includes(state.filterStatus)) {
    rows = rows.filter((r) => r.buff.state === state.filterStatus);
  }
  const get = SORTERS[state.sortKey] || SORTERS.role;
  return rows.slice().sort((a, b) => {
    let x = get(a), y = get(b);
    if (x == null) x = -Infinity;
    if (y == null) y = -Infinity;
    let c;
    if (typeof x === "string" && typeof y === "string") c = x.localeCompare(y);
    else c = x === y ? 0 : (x < y ? -1 : 1);
    if (c === 0) c = a.roleRank - b.roleRank || a.name.localeCompare(b.name);
    return c * state.sortDir;
  });
}

/* ---------- cells ---------- */
function nameCell(row) {
  const sub = h("div", { class: "sub" }, row.level != null ? "Lv " + row.level : "");
  if (ROLE_LETTER[row.role]) {
    sub.append(h("span", { class: "role " + row.role, title: ROLE_LABEL[row.role] }, ROLE_LETTER[row.role]));
  }
  return h("td", {},
    h("div", { class: "namecell" },
      avatarEl(row.raw && row.raw.avatarUrl, row.name, "avatar"),
      h("div", {}, h("div", { class: "nm" }, row.name), sub)));
}

function pillCell(row) {
  const b = row.buff;
  const td = h("td");
  if (b.state === "neutral") {
    td.append(h("span", { class: "timer ready" }, "Ready"));
  } else if (b.endAt) {
    td.append(h("span", { class: "timer " + b.state }, icon("pill"),
      h("span", { "data-end": String(b.endAt) }, dur(b.endAt - Date.now()))));
  } else {
    td.append(h("span", { class: "timer " + b.state }, icon("pill"), b.state === "buffed" ? "Buffed" : "Debuffed"));
  }
  return td;
}

function barEl(kind, b) {
  const pct = b.cur != null && b.max ? Math.max(0, Math.min(100, (b.cur / b.max) * 100)) : 0;
  const el = h("div", { class: "bar " + kind + (pct < 8 ? " low" : "") },
    h("span", { class: "fill", style: "width:" + pct.toFixed(1) + "%" }),
    icon(kind === "health" ? "heart" : "fork"),
    h("span", { class: "val" }, b.cur == null ? "—" : fmt(b.cur) + " / " + fmt(b.max)),
    b.regen != null ? h("span", { class: "regen" }, icon("up"), fmt(b.regen)) : null);
  return el;
}

function resourcesCell(row) {
  return h("td", {}, h("div", { class: "res" }, barEl("health", row.health), barEl("hunger", row.hunger)));
}

function detailRow(row) {
  const u = row.raw;
  const tr = h("tr", { class: "detail" });
  const td = h("td", { colspan: "5" });
  if (!u) {
    td.textContent = "Could not load this member: " + row.error;
    tr.append(td);
    return tr;
  }
  const sk = u.skills || {};
  const pairs = [
    ["Military rank", u.militaryRank != null ? u.militaryRank : "—"],
    ["Crit chance", sk.criticalChance ? sk.criticalChance.total + "%" : "—"],
    ["Crit damage", sk.criticalDamages ? sk.criticalDamages.total + "%" : "—"],
    ["Precision", sk.precision ? sk.precision.total + "%" : "—"],
    ["Armor", sk.armor ? sk.armor.total + "%" : "—"],
    ["Dodge", sk.dodge ? sk.dodge.total + "%" : "—"],
    ["Loot chance", sk.lootChance ? sk.lootChance.total + "%" : "—"],
    ["Health regen / h", row.health.regen != null ? fmt(row.health.regen) : "—"],
    ["Hunger regen / h", row.hunger.regen != null ? fmt(row.hunger.regen) : "—"],
    ["Total XP", fmt(u.leveling ? u.leveling.totalXp : null)],
    ["Wealth rank value", u.rankings && u.rankings.userWealth ? fmt(u.rankings.userWealth.value) : "—"],
    ["Damage rank", u.rankings && u.rankings.userDamages ? "#" + u.rankings.userDamages.rank : "—"],
  ];
  if (row.buff.codes.length) pairs.unshift(["Active buff", row.buff.codes.join(", ")]);
  const grid = h("div", { class: "detailgrid" });
  pairs.forEach(([k, v]) => grid.append(h("div", {}, h("span", {}, k), String(v))));
  td.append(grid);
  tr.append(td);
  return tr;
}

/* ---------- header ---------- */
function statEl(cls, iconName, count, label) {
  return h("div", { class: "stat " + cls }, icon(iconName), h("span", { class: "big" }, count), label);
}

function renderHeader() {
  const mu = state.mu;
  if (mu) {
    $("#muName").textContent = mu.name || CONFIG.MU_NAME;
    $("#muAvatar").replaceWith(Object.assign(avatarEl(mu.avatarUrl, mu.name || CONFIG.MU_NAME, "mu-avatar"), { id: "muAvatar" }));
    const up = mu.activeUpgradeLevels || {};
    const chips = [];
    if (up.headquarters != null) chips.push(h("span", { class: "chip", title: "Headquarters level" }, icon("hq"), up.headquarters));
    if (up.dormitories != null) chips.push(h("span", { class: "chip", title: "Dormitories level" }, icon("bed"), up.dormitories));
    $("#chips").replaceChildren(...chips);
  }
  const ok = state.rows.filter((r) => !r.failed);
  const n = (s) => ok.filter((r) => r.buff.state === s).length;
  $("#stats").replaceChildren(
    statEl("members", "users", state.rows.length, "Members"),
    statEl("buffed", "pill", n("buffed"), "Buffed"),
    statEl("ready", "pill", n("neutral"), "Ready"),
    statEl("debuffed", "pill", n("debuffed"), "Debuffed"));
  $("#tabCount").textContent = String(state.rows.length);
}

function render() {
  const now = Date.now();
  renderHeader();

  const banner = $("#errorBanner");
  if (state.error) { banner.hidden = false; banner.textContent = state.error; }
  else banner.hidden = true;

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.sortKey;
    th.classList.toggle("sorted", active);
    th.classList.toggle("desc", active && state.sortDir === -1);
  });

  const rows = visibleRows();
  $("#range").textContent = rows.length
    ? "1–" + rows.length + " of " + state.rows.length
    : (state.rows.length ? "No members match" : "No data yet");

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = h("tr", {
      class: "row",
      onclick: () => {
        if (state.expanded.has(row.id)) state.expanded.delete(row.id); else state.expanded.add(row.id);
        render();
      },
    });
    tr.append(
      nameCell(row),
      pillCell(row),
      resourcesCell(row),
      h("td", { class: "num mono hide-sm" }, fmt(row.damage)),
      h("td", { class: "muted hide-sm" }, row.failed
        ? "load error"
        : h("span", { "data-seen": row.lastSeen != null ? String(row.lastSeen) : "" }, relAgo(row.lastSeen, now))));
    frag.append(tr);
    if (state.expanded.has(row.id)) frag.append(detailRow(row));
  }
  $("#rows").replaceChildren(frag);
  updateStatus();
}

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
