// Числа и даты в русском формате: 2 051,3 · +1,38 · −21,2% · 19.10, 23:47

const nf = (digits: number) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const sign = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "");

/** Цена: 1 знак после запятой от 1000, иначе 4 значащие цифры. */
export function price(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return nf(1).format(x);
  return new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 4 }).format(x);
}

export function usd(x: number, withSign = false): string {
  const s = nf(2).format(Math.abs(x));
  return withSign ? sign(x) + s : (x < 0 ? "−" : "") + s;
}

export function pct(x: number, withSign = false): string {
  return (withSign ? sign(x) : x < 0 ? "−" : "") + nf(1).format(Math.abs(x)) + "%";
}

export function rMultiple(x: number): string {
  return sign(x) + nf(2).format(Math.abs(x)) + "R";
}

export function dateTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function clock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export type Tone = "up" | "down" | "neutral";

export const tone = (x: number): Tone => (x > 0 ? "up" : x < 0 ? "down" : "neutral");
