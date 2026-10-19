"use strict";
// Мини-приложение TradeTrust. Данные — с сервера бота (/api/*), вход — по подписи Telegram (initData).

const tg = window.Telegram && window.Telegram.WebApp;
const state = { tab: "overview", status: null, coin: null, chart: null, busy: false, error: null };
const MODES = [["signals", "Сигналы"], ["confirm", "Подтверждение"], ["auto", "Авто"]];
const ENV = { paper: ["Бумажный счёт", "accent"], demo: ["Демо Bybit", "accent"], testnet: ["Тестнет Bybit", "accent"],
  mainnet: ["Реальный счёт", "down"] };
const REASON = { stop: "стоп", signal: "сигнал", manual: "вручную" };

// --- утилиты ------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const price = (x) => x == null ? "—" : x >= 1000 ? x.toLocaleString("ru-RU", { maximumFractionDigits: 1 })
  : Number(x.toPrecision(4)).toLocaleString("ru-RU", { maximumSignificantDigits: 4 });
const usd = (x, sign = false) => (sign && x > 0 ? "+" : "") +
  x.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (x, d) => x.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, sign = true) => (sign && x > 0 ? "+" : "") + num(x, 1) + "%";
const rr = (x) => (x > 0 ? "+" : "") + num(x, 2) + "R";
const cls = (x) => x > 0 ? "up" : x < 0 ? "down" : "";
const time = (sec) => new Date(sec * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const haptic = (kind = "light") => tg?.HapticFeedback?.impactOccurred(kind);

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

function confirmDialog(text) {
  return new Promise((resolve) => tg?.showConfirm ? tg.showConfirm(text, resolve) : resolve(window.confirm(text)));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Authorization": "tma " + (tg?.initData || ""), "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Нет доступа: приложение открывается только владельцем бота через Telegram.");
  if (!res.ok) throw new Error(data.error || "Ошибка " + res.status);
  return data;
}

// --- данные ---------------------------------------------------------------------
async function load() {
  try {
    state.status = await api("/api/status");
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

async function loadChart(coin) {
  state.chart = null;
  render();
  try {
    state.chart = await api("/api/candles?coin=" + encodeURIComponent(coin));
  } catch (e) {
    state.chart = { error: e.message };
  }
  if (state.coin === coin) render();
}

async function act(path, body) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const r = await api(path, { method: "POST", body: JSON.stringify(body || {}) });
    haptic("medium");
    toast(r.message || "Готово");
  } catch (e) {
    tg?.HapticFeedback?.notificationOccurred("error");
    toast(e.message);
  }
  state.busy = false;
  await load();
  if (state.coin) loadChart(state.coin);
}

// --- сигналы: то же, что видит бот на последней свече ------------------------------
function coinState(coin, s, held) {
  if (s.error) return { label: "нет данных", color: "muted", order: 5 };
  if (held) return { label: "в позиции", color: "accent", order: 1 };
  if (s.cross_up && s.regime_ok) return { label: "ВХОД", color: "up", order: 0 };
  if (s.cross_up) return { label: "фильтр BTC", color: "amber", order: 2 };
  if (s.trend_down) return { label: "тренд вниз", color: "muted", order: 4 };
  return { label: "тренд вверх", color: "muted", order: 3 };
}

function chip(label, color) {
  const style = color === "accent" ? "color:var(--accent)" : color === "muted" ? "color:var(--muted)" : "";
  return `<span class="chip ${color}" style="${style}">${esc(label)}</span>`;
}

// --- экраны -------------------------------------------------------------------------
function renderOverview(s) {
  const eq = s.equity;
  const [envName, envColor] = ENV[s.env] || [s.env, "accent"];
  const paused = s.paused;
  let html = `<div class="card">
    <div class="row"><span class="badge ${envColor}" style="${envColor === "accent" ? "color:var(--accent)" : ""}">${esc(envName)}</span>
      <span class="grow"></span><button class="muted small" data-action="refresh">Обновить ↻</button></div>
    <div class="big">${usd(eq.total)} <span class="muted small">USDT</span></div>
    <div class="small muted">свободно ${usd(eq.free)} · в позициях <span class="${cls(eq.unrealized)}">${usd(eq.unrealized, true)}</span></div>
    <div class="seg">${MODES.map(([k, n]) => `<button data-action="mode" data-mode="${k}" class="${s.mode === k ? "on" : ""}" ${state.busy ? "disabled" : ""}>${n}</button>`).join("")}</div>
    <div class="row" style="margin-top:8px">
      <div class="grow ${paused ? "amber" : "up"} small bold">${paused ? "⏸ Пауза: " + esc(paused) : "▶ Работает"}</div>
      <button class="btn ghost" data-action="${paused ? "resume" : "pause"}" ${state.busy ? "disabled" : ""}>${paused ? "Продолжить" : "Пауза"}</button>
    </div></div>`;

  if (s.proposals.length) {
    html += `<h2>Ждут подтверждения</h2>`;
    for (const p of s.proposals) {
      html += `<div class="card">
        <div class="row"><b class="grow">ВХОД ${esc(p.coin)}</b>${chip("до " + time(p.expires_at).split(", ")[1], "muted")}</div>
        <div class="kv" style="margin-top:8px">
          <div>Купить</div><div>${price(p.qty)} ${esc(p.coin)} ≈ ${usd(p.qty * p.price)} $</div>
          <div>Цена</div><div>~${price(p.price)}</div>
          <div>Стоп</div><div>${price(p.stop)} (−${pct((1 - p.stop / p.price) * 100, false)})</div>
          <div>Риск</div><div>${usd(p.risk_usdt)} $</div>
        </div>
        <div class="btns"><button class="btn good" data-action="confirm" data-id="${esc(p.id)}" ${state.busy ? "disabled" : ""}>Купить</button>
          <button class="btn ghost" data-action="reject" data-id="${esc(p.id)}" ${state.busy ? "disabled" : ""}>Пропустить</button></div>
      </div>`;
    }
  }

  html += `<h2>Позиции</h2>`;
  if (!s.positions.length) html += `<div class="card muted small">Открытых позиций нет. Бот ждёт сигнала.</div>`;
  for (const p of s.positions) {
    const change = (p.price / p.entry - 1) * 100;
    const toStop = (1 - p.stop / p.price) * 100;
    html += `<div class="card tap" data-action="coin" data-coin="${esc(p.coin)}">
      <div class="row"><b class="grow">${esc(p.coin)}</b><b class="${cls(p.pnl_usdt)}">${usd(p.pnl_usdt, true)} $</b></div>
      <div class="row small muted"><span class="grow">${price(p.qty)} шт · вход ${price(p.entry)} → ${price(p.price)}</span>
        <span class="${cls(change)}">${pct(change)}</span></div>
      <div class="small muted">стоп ${price(p.stop)} · до стопа ${pct(toStop, false)} · с ${time(p.opened_at)}</div>
    </div>`;
  }
  return html;
}

function renderSignals(s) {
  const held = new Set(s.positions.map((p) => p.coin));
  const rows = Object.entries(s.signals || {}).map(([coin, sig]) => ({ coin, sig, st: coinState(coin, sig, held.has(coin)) }))
    .sort((a, b) => a.st.order - b.st.order || a.coin.localeCompare(b.coin));
  const bar = s.last_bar ? `Свеча закрылась ${time(s.last_bar + 4 * 3600)}` : "Ждём закрытия первой свечи";
  let html = `<h1>Сигналы · 4ч</h1><div class="small muted" style="margin:-6px 4px 10px">${bar}</div><div class="list">`;
  if (!rows.length) html += `<div class="item muted small">Данных пока нет.</div>`;
  for (const { coin, sig, st } of rows) {
    html += `<div class="item row tap" data-action="coin" data-coin="${esc(coin)}">
      <div class="grow"><b>${esc(coin)}</b><div class="small muted">${sig.error ? "ошибка загрузки" : price(sig.price)}</div></div>
      ${chip(st.label, st.color)}</div>`;
  }
  return html + `</div><div class="small muted" style="margin:10px 4px">Сигналы — результат правил системы, а не рекомендация.</div>`;
}

function renderJournal(s) {
  const t = s.trades;
  const pnl = t.reduce((a, x) => a + x.pnl_usdt, 0);
  const wins = t.filter((x) => x.pnl_usdt > 0);
  const lossSum = -t.filter((x) => x.pnl_usdt <= 0).reduce((a, x) => a + x.pnl_usdt, 0);
  const rs = t.filter((x) => x.r != null).map((x) => x.r);
  const avgR = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : null;
  let html = `<h1>Журнал</h1><div class="stats">
    <div class="stat"><b>${t.length}</b><span>сделок</span></div>
    <div class="stat"><b>${t.length ? Math.round(100 * wins.length / t.length) + "%" : "—"}</b><span>прибыльных</span></div>
    <div class="stat"><b class="${cls(pnl)}">${usd(pnl, true)}</b><span>итог, $</span></div>
    <div class="stat"><b class="${avgR == null ? "" : cls(avgR)}">${avgR == null ? "—" : rr(avgR).slice(0, -1)}</b><span>средний R</span></div>
    <div class="stat"><b>${lossSum > 0 ? num(wins.reduce((a, x) => a + x.pnl_usdt, 0) / lossSum, 2) : "—"}</b><span>profit factor</span></div>
    <div class="stat"><b>${s.positions.length}</b><span>открыто</span></div>
  </div>
  <div class="small muted" style="margin:8px 4px">R — результат в долях риска: +2R значит заработали вдвое больше, чем рисковали.</div>
  <h2>Сделки</h2><div class="list">`;
  if (!t.length) html += `<div class="item muted small">Закрытых сделок пока нет.</div>`;
  for (const x of t) {
    html += `<div class="item row"><div class="grow"><b>${esc(x.coin)}</b>
      <div class="small muted">${price(x.entry)} → ${price(x.exit)} · ${REASON[x.reason] || esc(x.reason)} · ${time(x.closed_at)}</div></div>
      <div class="right"><b class="${cls(x.pnl_usdt)}">${usd(x.pnl_usdt, true)} $</b>
      ${x.r != null ? `<div class="small muted">${rr(x.r)}</div>` : ""}</div></div>`;
  }
  html += `</div><h2>События</h2><div class="list">`;
  for (const e of s.events.slice(0, 20)) {
    html += `<div class="item small"><span class="muted">${time(e.ts)}</span> <span class="${e.level === "error" ? "down" : ""}">${esc(e.text)}</span></div>`;
  }
  return html + `</div>`;
}

function renderCoin(s, coin) {
  const sig = (s.signals || {})[coin] || {};
  const pos = s.positions.find((p) => p.coin === coin);
  const st = coinState(coin, sig, !!pos);
  const set = s.settings;
  let html = `<div class="row" style="margin:4px 4px 10px">
      <h1 class="grow" style="margin:0">${esc(coin)}<span class="muted">/USDT</span></h1>${chip(st.label, st.color)}</div>
    <div class="card"><div class="big" style="font-size:24px">${price(pos ? pos.price : sig.price)}</div>
      <canvas class="chart" id="chart"></canvas>
      <div class="legend"><span><i style="background:var(--accent)"></i>EMA ${set.ema_fast}</span>
        <span><i style="background:var(--amber)"></i>EMA ${set.ema_slow}</span>
        ${pos ? `<span><i style="background:var(--down)"></i>стоп</span>` : ""}</div>
      ${state.chart?.error ? `<div class="small down">${esc(state.chart.error)}</div>` : ""}
    </div>`;
  if (pos) {
    html += `<div class="card"><b>Позиция</b><div class="kv" style="margin-top:8px">
      <div>Количество</div><div>${price(pos.qty)}</div>
      <div>Вход</div><div>${price(pos.entry)}</div>
      <div>Стоп</div><div>${price(pos.stop)}</div>
      <div>Результат</div><div class="${cls(pos.pnl_usdt)}">${usd(pos.pnl_usdt, true)} $</div></div>
      <div class="btns"><button class="btn danger" data-action="close" data-coin="${esc(coin)}" ${state.busy ? "disabled" : ""}>Закрыть по рынку</button></div></div>`;
  } else if (st.label === "ВХОД" && sig.atr) {
    const stop = sig.price - set.atr_mult * sig.atr;
    const risk = s.equity.total * set.risk_pct / 100;
    const qty = Math.min(risk / (sig.price - stop), s.equity.free / sig.price);
    html += `<div class="card"><b>План по системе</b><div class="kv" style="margin-top:8px">
      <div>Купить</div><div>~${price(qty)} (${usd(qty * sig.price)} $)</div>
      <div>Стоп</div><div>${price(stop)} (−${pct((1 - stop / sig.price) * 100, false)})</div>
      <div>Риск</div><div>${usd(qty * (sig.price - stop))} $ (${set.risk_pct}%)</div>
      <div>Выход</div><div>EMA ${set.ema_fast} ниже EMA ${set.ema_slow} или стоп</div></div>
      <div class="small muted" style="margin-top:8px">${s.mode === "signals" ? "Режим «Сигналы»: бот сделку не открывает."
        : "Бот обработал сигнал при закрытии свечи — смотрите «Обзор»."}</div></div>`;
  }
  if (!sig.error && sig.ema_fast) {
    html += `<div class="card"><div class="kv">
      <div>EMA ${set.ema_fast}</div><div>${price(sig.ema_fast)}</div>
      <div>EMA ${set.ema_slow}</div><div>${price(sig.ema_slow)}</div>
      <div>ATR</div><div>${price(sig.atr)} (${pct(sig.atr / sig.price * 100, false)})</div></div></div>`;
  }
  return html;
}

// --- график свечей ----------------------------------------------------------------------
function drawChart() {
  const c = $("#chart");
  const d = state.chart;
  if (!c || !d || d.error) return;
  const css = getComputedStyle(document.documentElement);
  const color = (v) => css.getPropertyValue(v).trim();
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);

  const n = Math.min(90, d.time.length), from = d.time.length - n;
  const sl = (a) => a.slice(from);
  const [o, h, l, cl, ef, es] = [sl(d.open), sl(d.high), sl(d.low), sl(d.close), sl(d.ema_fast), sl(d.ema_slow)];
  const stop = d.position?.stop, entry = d.position?.entry;
  const vals = [...h, ...l, ...ef.filter((x) => x != null), ...es.filter((x) => x != null), stop, entry].filter((x) => x != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padY = (hi - lo) * 0.06 || 1; lo -= padY; hi += padY;
  const axisW = 52, plotW = W - axisW;
  const x = (i) => (i + 0.5) * plotW / n;
  const y = (v) => H - (v - lo) / (hi - lo) * H;

  g.font = "11px -apple-system, Roboto, sans-serif";
  g.fillStyle = color("--muted");
  g.strokeStyle = "rgba(128,128,128,.18)";
  g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, yy = y(v);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
    g.fillText(price(v), plotW + 6, Math.min(H - 2, Math.max(10, yy + 4)));
  }
  const bw = Math.max(1.5, plotW / n * 0.65);
  for (let i = 0; i < n; i++) {
    const up = cl[i] >= o[i];
    g.strokeStyle = g.fillStyle = up ? color("--up") : color("--down");
    g.beginPath(); g.moveTo(x(i), y(h[i])); g.lineTo(x(i), y(l[i])); g.stroke();
    const top = y(Math.max(o[i], cl[i])), bot = y(Math.min(o[i], cl[i]));
    g.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
  }
  const line = (arr, col) => {
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
    let started = false;
    arr.forEach((v, i) => { if (v == null) return; started ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); started = true; });
    g.stroke();
  };
  line(ef, color("--accent"));
  line(es, color("--amber"));
  const hline = (v, col) => {
    if (v == null) return;
    g.setLineDash([6, 5]); g.strokeStyle = col; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, y(v)); g.lineTo(plotW, y(v)); g.stroke(); g.setLineDash([]);
  };
  hline(stop, color("--down"));
  hline(entry, color("--muted"));
}

// --- отрисовка и события ------------------------------------------------------------------
function render() {
  const app = $("#app");
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  if (!tg?.initData) {
    app.innerHTML = `<div class="center"><h1>TradeTrust</h1><p class="muted">Откройте приложение через своего Telegram-бота: кнопка «Открыть» внизу чата.</p></div>`;
    return;
  }
  const s = state.status;
  if (!s) {
    app.innerHTML = state.error ? `<div class="center down">${esc(state.error)}</div>` : `<div class="center muted">Загрузка…</div>`;
    return;
  }
  let html = state.error ? `<div class="card small down">Нет связи с сервером: ${esc(state.error)}</div>` : "";
  if (state.coin) html += renderCoin(s, state.coin);
  else if (state.tab === "signals") html += renderSignals(s);
  else if (state.tab === "journal") html += renderJournal(s);
  else html += renderOverview(s);
  app.innerHTML = html;
  if (state.coin) drawChart();
  tg.BackButton[state.coin ? "show" : "hide"]();
}

function openCoin(coin) {
  state.coin = coin;
  haptic();
  window.scrollTo(0, 0);
  loadChart(coin);
}

function closeCoin() {
  state.coin = null;
  state.chart = null;
  render();
}

document.addEventListener("click", async (ev) => {
  const tab = ev.target.closest("#tabs button");
  if (tab) {
    state.tab = tab.dataset.tab;
    state.coin = null;
    haptic();
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = ev.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === "coin") return openCoin(el.dataset.coin);
  if (a === "refresh") { haptic(); return load(); }
  if (a === "confirm") return act(`/api/proposals/${el.dataset.id}/confirm`);
  if (a === "reject") return act(`/api/proposals/${el.dataset.id}/reject`);
  if (a === "pause") return act("/api/pause");
  if (a === "resume") return act("/api/resume");
  if (a === "mode") {
    const mode = el.dataset.mode;
    if (mode === state.status?.mode) return;
    if (mode === "auto" && !(await confirmDialog("Бот будет сам покупать по сигналам, без подтверждения. Включить?"))) return;
    return act("/api/mode", { mode });
  }
  if (a === "close") {
    const coin = el.dataset.coin;
    if (!(await confirmDialog(`Закрыть ${coin}? Бот отменит стоп и продаст по рынку.`))) return;
    return act(`/api/positions/${coin}/close`);
  }
});

window.addEventListener("resize", () => state.coin && drawChart());

if (tg) {
  document.documentElement.classList.add("tg");
  tg.ready();
  tg.expand();
  tg.BackButton.onClick(closeCoin);
}
render();
if (tg?.initData) {
  load();
  setInterval(() => document.visibilityState === "visible" && load(), 20000);
}
