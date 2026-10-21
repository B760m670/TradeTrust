import { describe, expect, it } from "vitest";
import type { Bar } from "./candles";
import { boll, ewm, kdj, macd, mainLines, rsi, sar, sma, subPane, wr } from "./indicators";

const bar = (close: number, i: number, spread = 1): Bar =>
  ({ time: i * 60, open: close, high: close + spread, low: close - spread, close, volume: 10 + i });
const series = (closes: number[]) => closes.map((c, i) => bar(c, i));
const rising = series(Array.from({ length: 60 }, (_, i) => 100 + i));

describe("indicators", () => {
  it("averages wait for a full period", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ewm([2, 2, 2, 2], 3)).toEqual([null, null, 2, 2]);
    // DEA считается от первого значения DIF, пустые начальные значения пропускаются
    expect(ewm([null, null, 4, 4], 2)).toEqual([null, null, null, 4]);
  });

  it("bollinger bands hug a flat price and widen with moves", () => {
    const flat = boll(Array(25).fill(10));
    expect(flat.up[24]).toBe(10);
    expect(flat.low[24]).toBe(10);
    const moving = boll([...Array(19).fill(10), 20]);
    expect(moving.mid[19]).toBe(10.5);
    expect(moving.up[19]! - moving.mid[19]!).toBeCloseTo(2 * Math.sqrt((19 * 0.25 + 9.5 ** 2) / 20));
  });

  it("rsi is 100 when price only rises and 0 when it only falls", () => {
    const up = rsi(rising.map((b) => b.close), 6);
    expect(up[5]).toBeNull();
    expect(up[6]).toBe(100);
    expect(rsi([...rising].reverse().map((b) => b.close), 6)[30]).toBe(0);
  });

  it("macd is zero on a flat price and positive in an uptrend", () => {
    const flat = macd(Array(40).fill(5));
    expect(flat.dif[39]).toBe(0);
    expect(flat.hist[39]).toBe(0);
    const up = macd(rising.map((b) => b.close));
    expect(up.dif[24]).toBeNull();
    expect(up.dif[59]).toBeGreaterThan(0);
  });

  it("kdj and williams %R show where the close sits in its range", () => {
    const k = kdj(rising);
    expect(k.k[7]).toBeNull();
    expect(k.k[59]).toBeGreaterThan(80); // закрытие у верха диапазона
    expect(k.j[59]).toBeCloseTo(3 * k.k[59]! - 2 * k.d[59]!);
    const w = wr(rising);
    expect(w[12]).toBeNull();
    expect(w[59]).toBeGreaterThan(-20);
    expect(w[59]).toBeLessThanOrEqual(0);
  });

  it("parabolic sar stays under the lows in an uptrend and flips on a drop", () => {
    const s = sar(rising);
    rising.slice(2).forEach((b, i) => expect(s[i + 2]!).toBeLessThanOrEqual(b.low));
    const drop = [...rising, bar(80, 60)];
    expect(sar(drop)[60]).toBeGreaterThan(drop[60].high); // разворот — точка над ценой
  });

  it("builds Bybit's default lines, EMA with the bot's periods", () => {
    expect(mainLines("MA", rising, [20, 50]).map((l) => l.label)).toEqual(["MA7", "MA25", "MA99"]);
    expect(mainLines("EMA", rising, [20, 50]).map((l) => l.label)).toEqual(["EMA20", "EMA50"]);
    expect(subPane("VOL", rising).lines[0].tones?.[0]).toBe("up");
    expect(subPane("RSI", []).lines).toHaveLength(3);
    expect(subPane("MACD", rising).lines.map((l) => l.label)).toEqual(["MACD", "DIF", "DEA"]);
  });
});
