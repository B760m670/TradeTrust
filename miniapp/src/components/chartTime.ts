// Время на графиках — по часам телефона. Сам график считает в UTC, поэтому подписи
// и время под перекрестием форматируем сами (иначе в Москве 12:48 показывалось бы как 09:48).
import { TickMarkType, type Time } from "lightweight-charts";

const two = (n: number) => String(n).padStart(2, "0");

function toDate(t: Time): Date {
  if (typeof t === "number") return new Date(t * 1000);
  if (typeof t === "string") return new Date(t);
  return new Date(t.year, t.month - 1, t.day);
}

export function tickMark(t: Time, type: TickMarkType): string {
  const d = toDate(t);
  switch (type) {
    case TickMarkType.Year: return String(d.getFullYear());
    case TickMarkType.Month: return d.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "");
    case TickMarkType.DayOfMonth: return String(d.getDate());
    case TickMarkType.Time: return `${two(d.getHours())}:${two(d.getMinutes())}`;
    default: return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  }
}

/** Время под перекрестием: дата, а для внутридневных свечей ещё и время (с секундами — для «1с»). */
export function crosshairTime(withTime: boolean, withSeconds = false) {
  return (t: Time): string => {
    const d = toDate(t);
    const date = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
    if (!withTime) return date;
    return `${date} ${two(d.getHours())}:${two(d.getMinutes())}${withSeconds ? `:${two(d.getSeconds())}` : ""}`;
  };
}
