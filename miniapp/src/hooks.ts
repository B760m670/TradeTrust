import { useEffect, useRef, useState } from "react";

/** true, когда окно шире breakpoint (Telegram Desktop, планшет). */
export function useWide(minWidth = 900): boolean {
  const query = `(min-width: ${minWidth}px)`;
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Плавно «докручивает» число до нового значения. */
export function useAnimatedNumber(value: number, ms = 700): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || typeof requestAnimationFrame !== "function" || reducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      const v = start + (value - start) * eased;
      from.current = v;
      setShown(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

/** Текущее время, обновляется раз в минуту — для «свеча закроется в …». */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
