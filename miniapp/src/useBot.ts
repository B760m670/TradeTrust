import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Status } from "./api";
import { hapticResult } from "./telegram";

const REFRESH_MS = 20_000;

/** Статус бота с автообновлением и выполнение действий (покупка, режим, пауза, закрытие). */
export function useBot() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(async (action: () => Promise<{ message: string }>) => {
    setBusy(true);
    try {
      const r = await action();
      hapticResult(true);
      setMessage(r.message || "Готово");
    } catch (e) {
      hapticResult(false);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  const clearMessage = useCallback(() => setMessage(null), []);

  return { status, error, busy, message, clearMessage, refresh, act };
}
