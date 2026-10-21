// Индикаторы графика — те же, что в ряду под графиком у Bybit, с их настройками по умолчанию.
// Основные рисуются поверх свечей (одновременно один), дополнительные — в своих окнах под графиком.
import type { Bar } from "./candles";

export type MainInd = "MA" | "EMA" | "BOLL" | "SAR";
export type SubInd = "VOL" | "MACD" | "RSI" | "KDJ" | "WR";
export const MAIN_INDS: MainInd[] = ["MA", "EMA", "BOLL", "SAR"];
export const SUB_INDS: SubInd[] = ["VOL", "MACD", "RSI", "KDJ", "WR"];
export const MAX_SUBS = 2; // больше окон под графиком на телефоне не помещается

type Values = (number | null)[];
/** Цвет линии — номер в палитре графика (0 — основной, 1 — второй, 2 — третий), up/down — цвета роста и падения. */
export type Tone = 0 | 1 | 2 | "up" | "down";
export interface IndLine {
  label: string;
  values: Values;
  tone: Tone;
  style?: "line" | "dots" | "hist";
  tones?: Tone[]; // для столбиков: цвет каждого
}
export interface IndPane { title: string; lines: IndLine[]; digits?: number }

/** Простая средняя; null, пока не набралось period значений. */
export function sma(values: Values, period: number): Values {
  let sum = 0, count = 0;
  return values.map((v, i) => {
    if (v == null) return null;
    sum += v;
    count++;
    const old = values[i - period];
    if (count > period && old != null) { sum -= old; count--; }
    return count >= period ? sum / period : null;
  });
}

/** Экспоненциальная средняя от первого значения (adjust=False, как у бота и бирж); null — пока период не набран. */
export function ewm(values: Values, period: number, alpha = 2 / (period + 1)): Values {
  let e: number | null = null, n = 0;
  return values.map((v) => {
    if (v == null) return null;
    e = e == null ? v : v * alpha + e * (1 - alpha);
    return ++n >= period ? e : null;
  });
}

const slice = (values: number[], i: number, period: number) => values.slice(Math.max(0, i - period + 1), i + 1);

/** Полосы Боллинджера: средняя за 20 и два стандартных отклонения. */
export function boll(closes: number[], period = 20, mult = 2): { up: Values; mid: Values; low: Values } {
  const mid = sma(closes, period);
  const dev = closes.map((_, i) => {
    const m = mid[i];
    if (m == null) return null;
    const w = slice(closes, i, period);
    return Math.sqrt(w.reduce((s, c) => s + (c - m) ** 2, 0) / period);
  });
  return {
    up: mid.map((m, i) => (m == null ? null : m + mult * dev[i]!)),
    mid,
    low: mid.map((m, i) => (m == null ? null : m - mult * dev[i]!)),
  };
}

/** Параболик SAR (шаг 0.02, максимум 0.2) — точки под ценой в росте и над ценой в падении. */
export function sar(bars: Bar[], step = 0.02, max = 0.2): Values {
  if (bars.length < 2) return bars.map(() => null);
  let up = bars[1].close >= bars[0].close;
  let point = up ? bars[0].low : bars[0].high;
  let extreme = up ? bars[1].high : bars[1].low;
  let af = step;
  const out: Values = [null, point];
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i];
    let next = point + af * (extreme - point);
    // SAR не заходит за экстремумы двух прошлых свечей
    next = up ? Math.min(next, bars[i - 1].low, bars[i - 2].low) : Math.max(next, bars[i - 1].high, bars[i - 2].high);
    if (up ? b.low < next : b.high > next) {
      up = !up;
      next = extreme;
      extreme = up ? b.high : b.low;
      af = step;
    } else if (up ? b.high > extreme : b.low < extreme) {
      extreme = up ? b.high : b.low;
      af = Math.min(af + step, max);
    }
    point = next;
    out.push(point);
  }
  return out;
}

/** MACD (12, 26, 9): DIF — разница средних, DEA — её средняя, столбики — DIF − DEA. */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): { dif: Values; dea: Values; hist: Values } {
  const f = ewm(closes, fast), s = ewm(closes, slow);
  const dif = closes.map((_, i) => (f[i] == null || s[i] == null ? null : f[i]! - s[i]!));
  const dea = ewm(dif, signal);
  return { dif, dea, hist: dif.map((d, i) => (d == null || dea[i] == null ? null : d - dea[i]!)) };
}

/** RSI по Уайлдеру: средний рост к среднему движению за период, 0–100. */
export function rsi(closes: number[], period: number): Values {
  const diffs = closes.map((c, i) => (i ? c - closes[i - 1] : null));
  const gain = ewm(diffs.map((d) => (d == null ? null : Math.max(d, 0))), period, 1 / period);
  const move = ewm(diffs.map((d) => (d == null ? null : Math.abs(d))), period, 1 / period);
  return gain.map((g, i) => (g == null || move[i] == null ? null : move[i] ? (g / move[i]!) * 100 : 50));
}

const highest = (bars: Bar[], i: number, n: number) => Math.max(...bars.slice(Math.max(0, i - n + 1), i + 1).map((b) => b.high));
const lowest = (bars: Bar[], i: number, n: number) => Math.min(...bars.slice(Math.max(0, i - n + 1), i + 1).map((b) => b.low));

/** KDJ (9, 3, 3): где закрытие внутри диапазона последних 9 свечей, сглаженное; J = 3K − 2D. */
export function kdj(bars: Bar[], period = 9, kn = 3, dn = 3): { k: Values; d: Values; j: Values } {
  let k = 50, d = 50;
  const K: Values = [], D: Values = [], J: Values = [];
  bars.forEach((b, i) => {
    if (i + 1 < period) { K.push(null); D.push(null); J.push(null); return; }
    const hi = highest(bars, i, period), lo = lowest(bars, i, period);
    const rsv = hi === lo ? 50 : ((b.close - lo) / (hi - lo)) * 100;
    k = (rsv + (kn - 1) * k) / kn;
    d = (k + (dn - 1) * d) / dn;
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  });
  return { k: K, d: D, j: J };
}

/** Williams %R (14): от 0 (закрытие на максимуме) до −100 (на минимуме). */
export function wr(bars: Bar[], period = 14): Values {
  return bars.map((b, i) => {
    if (i + 1 < period) return null;
    const hi = highest(bars, i, period), lo = lowest(bars, i, period);
    return hi === lo ? -50 : ((hi - b.close) / (hi - lo)) * -100;
  });
}

const direction = (bars: Bar[]): Tone[] => bars.map((b) => (b.close >= b.open ? "up" : "down"));

/** Линии основного индикатора поверх свечей. EMA — с периодами бота: по ним он решает о входе и выходе. */
export function mainLines(ind: MainInd, bars: Bar[], botEma: [number, number]): IndLine[] {
  const closes = bars.map((b) => b.close);
  switch (ind) {
    case "MA": return [7, 25, 99].map((p, i) => ({ label: `MA${p}`, values: sma(closes, p), tone: i as Tone }));
    case "EMA": return botEma.map((p, i) => ({ label: `EMA${p}`, values: ewm(closes, p), tone: i as Tone }));
    case "BOLL": {
      const b = boll(closes);
      return [{ label: "UP", values: b.up, tone: 1 }, { label: "MB", values: b.mid, tone: 0 }, { label: "DN", values: b.low, tone: 2 }];
    }
    case "SAR": return [{ label: "SAR", values: sar(bars), tone: 0, style: "dots" }];
  }
}

/** Окно дополнительного индикатора под графиком. */
export function subPane(ind: SubInd, bars: Bar[]): IndPane {
  const closes = bars.map((b) => b.close);
  switch (ind) {
    case "VOL": {
      const vol = bars.map((b) => b.volume);
      return { title: "VOL", digits: -1, lines: [
        { label: "VOL", values: vol, tone: "up", style: "hist", tones: direction(bars) },
        { label: "MA5", values: sma(vol, 5), tone: 0 },
        { label: "MA10", values: sma(vol, 10), tone: 1 },
      ] };
    }
    case "MACD": {
      const m = macd(closes);
      return { title: "MACD", lines: [
        { label: "MACD", values: m.hist, tone: "up", style: "hist", tones: m.hist.map((h) => (h != null && h < 0 ? "down" : "up")) },
        { label: "DIF", values: m.dif, tone: 0 },
        { label: "DEA", values: m.dea, tone: 1 },
      ] };
    }
    case "RSI":
      return { title: "RSI", digits: 2, lines: [6, 12, 24].map((p, i) => ({ label: `RSI${p}`, values: rsi(closes, p), tone: i as Tone })) };
    case "KDJ": {
      const k = kdj(bars);
      return { title: "KDJ", digits: 2, lines: [
        { label: "K", values: k.k, tone: 0 }, { label: "D", values: k.d, tone: 1 }, { label: "J", values: k.j, tone: 2 },
      ] };
    }
    case "WR":
      return { title: "WR", digits: 2, lines: [{ label: "WR14", values: wr(bars), tone: 0 }] };
  }
}
