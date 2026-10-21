import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type AdminData, type AdminSettings, type AdminUser } from "../api";
import { Stepper, Switch } from "../components/controls";
import { AlertIcon } from "../components/icons";
import { Button, Card, Chip, Empty, Segmented, Skeleton, StatusDot, Tile, Value } from "../components/ui";
import { dateTime, pct, usd } from "../format";
import { useNow } from "../hooks";
import { ago, duration, filterUsers } from "../logic";
import { confirmAction, haptic, hapticResult } from "../telegram";

type Section = "summary" | "users" | "system" | "manage";
const SECTIONS: [Section, string][] = [["summary", "Сводка"], ["users", "Люди"], ["system", "Система"], ["manage", "Опции"]];
const REFRESH_MS = 20_000;

/** Админка владельца: пользователи, рост, состояние сервера, управление и рассылка. */
export function Admin() {
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("summary");
  const [toast, setToast] = useState<string | null>(null);
  const load = useCallback(() => api.admin().then((d) => { setData(d); setError(null); }, (e: Error) => setError(e.message)), []);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const run = async (action: () => Promise<{ message: string }>) => {
    try {
      const r = await action();
      hapticResult(true);
      setToast(r.message);
    } catch (e) {
      hapticResult(false);
      setToast((e as Error).message);
    }
    await load();
  };

  if (!data) {
    return error
      ? <Empty icon={<AlertIcon size={28} />} title="Админка не загрузилась">{error}</Empty>
      : <div className="admin"><Skeleton height={40} /><Skeleton height={160} /><Skeleton height={220} /></div>;
  }
  return (
    <div className="admin">
      <header className="admin-head">
        <h1>Админка</h1>
        <span className="muted small">только для вас</span>
      </header>
      <Segmented label="Раздел админки" options={SECTIONS} value={section} onChange={setSection} />
      {toast && <p className="admin-toast" role="status" onClick={() => setToast(null)}>{toast}</p>}
      {!data.available && section !== "system"
        ? <Empty title="Демо-счета недоступны">Для них нужен Telegram-бот: TELEGRAM_TOKEN в .env на сервере.</Empty>
        : section === "summary" ? <Summary data={data} />
        : section === "users" ? <Users rows={data.users} run={run} />
        : section === "system" ? <System data={data} />
        : <Manage settings={data.settings!} users={data.users.length} run={run} />}
    </div>
  );
}

function Summary({ data }: { data: AdminData }) {
  const s = data.stats!;
  const max = Math.max(1, ...s.signups.map((d) => d.count));
  const rated = s.profitable + s.losing;
  return (
    <>
      <div className="tiles">
        <Tile label="Пользователей" value={s.total} hint={`лимит ${data.settings!.max_users}`} />
        <Tile label="Новых за сутки" value={s.new_day} hint={`за неделю ${s.new_week}`} tone={s.new_day ? "up" : undefined} />
        <Tile label="Заходили за сутки" value={s.active_day} hint={`за неделю ${s.active_week}`} />
        <Tile label="Бот в плюсе" value={rated ? `${s.profitable} из ${rated}` : "—"}
          hint={s.losing ? `в минусе ${s.losing}` : "у демо-счетов"} tone={s.profitable > s.losing ? "up" : undefined} />
      </div>
      <Card title="Регистрации за 30 дней" aside={<span className="muted small">всего {s.signups.reduce((a, d) => a + d.count, 0)}</span>}>
        <div className="signups" role="img" aria-label="Регистрации по дням">
          {s.signups.map((d) => (
            <span key={d.day} className="signup-bar" title={`${new Date(d.day * 1000).toLocaleDateString("ru-RU")}: ${d.count}`}
              style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} data-empty={d.count === 0 || undefined} />
          ))}
        </div>
        <div className="signups-axis muted small"><span>30 дн назад</span><span>сегодня</span></div>
      </Card>
      <Card>
        <p className="muted small admin-note">
          Регистрация {data.settings!.registration_open ? "открыта" : "закрыта"}
          {s.blocked ? ` · заблокировано: ${s.blocked}` : ""}. Сообщения о новых пользователях
          {data.settings!.notify_new_users ? " приходят в Telegram" : " не приходят — итог в ежедневной сводке"}.
        </p>
      </Card>
    </>
  );
}

function Users({ rows, run }: { rows: AdminUser[]; run: (a: () => Promise<{ message: string }>) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow();
  const shown = filterUsers(rows, query);
  const ask = async (u: AdminUser, action: "reset" | "block" | "unblock" | "delete", text: string) => {
    if (action !== "unblock" && !(await confirmAction(text))) return;
    await run(() => api.userAction(u.id, action));
  };
  if (!rows.length) return <Empty title="Пользователей пока нет">Демо-счёт открывается по /start в боте или при входе в приложение.</Empty>;
  return (
    <>
      <input className="admin-search" type="search" placeholder="Имя, @username или ID" value={query}
        onChange={(e) => setQuery(e.target.value)} aria-label="Поиск пользователей" />
      <div className="user-list">
        {shown.map((u) => {
          const who = u.name || `ID ${u.id}`;
          return (
            <Card key={u.id} className={`user-card${u.blocked ? " blocked" : ""}`}>
              <button className="user-row" aria-expanded={open === u.id} onClick={() => { haptic(); setOpen(open === u.id ? null : u.id); }}>
                <span className="user-avatar" aria-hidden="true">{who.slice(0, 1).toUpperCase()}</span>
                <span className="user-main">
                  <strong>{who}</strong>
                  <span className="muted small">{u.username ? `@${u.username} · ` : ""}был {ago(u.last_seen, now)}</span>
                </span>
                <span className="user-money">
                  <strong className="num">{u.equity == null ? "—" : `${usd(u.equity)} $`}</strong>
                  {u.pnl_pct != null && <Value tone={u.pnl_pct > 0 ? "up" : u.pnl_pct < 0 ? "down" : undefined}>{pct(u.pnl_pct, true)}</Value>}
                </span>
              </button>
              {open === u.id && (
                <div className="user-details">
                  <dl className="user-facts">
                    <dt>Telegram ID</dt><dd className="num">{u.id}</dd>
                    <dt>Регистрация</dt><dd>{u.joined_at ? dateTime(u.joined_at) : "—"}</dd>
                    <dt>Позиций</dt><dd>{u.positions}</dd>
                    <dt>Сделок</dt><dd>{u.trades}{u.trades ? ` · прибыльных ${u.wins}` : ""}</dd>
                    <dt>Режим</dt><dd>{u.mode}{u.paused ? ` · пауза (${u.paused})` : ""}</dd>
                  </dl>
                  <div className="user-actions">
                    <Button onClick={() => void ask(u, "reset", `Сбросить демо-счёт ${who}? Позиции и сделки сотрутся.`)}>Сбросить</Button>
                    {u.blocked
                      ? <Button onClick={() => void ask(u, "unblock", "")}>Разблокировать</Button>
                      : <Button onClick={() => void ask(u, "block", `Заблокировать ${who}? Он не сможет открыть приложение.`)}>Заблокировать</Button>}
                    <Button variant="danger" onClick={() => void ask(u, "delete", `Удалить демо-счёт ${who}? Это нельзя отменить.`)}>Удалить</Button>
                  </div>
                </div>
              )}
              {u.blocked && <div className="user-flags"><Chip tone="down">заблокирован</Chip></div>}
            </Card>
          );
        })}
        {!shown.length && <p className="muted small">Никого не нашлось.</p>}
      </div>
    </>
  );
}

function Row({ label, ok, children }: { label: string; ok: "up" | "amber" | "down"; children: ReactNode }) {
  return (
    <div className="sys-row">
      <StatusDot tone={ok} />
      <span className="sys-label">{label}</span>
      <span className="sys-value">{children}</span>
    </div>
  );
}

function System({ data }: { data: AdminData }) {
  const s = data.system;
  const now = s.now;
  const scanLate = s.last_scan == null || now - s.last_scan > 5 * 3600;
  const bybitOk = s.bybit.ok_at != null && (s.bybit.error_at == null || s.bybit.ok_at > s.bybit.error_at);
  const tgOk = s.telegram.ok_at != null && now - s.telegram.ok_at < 180;
  const mem = s.memory;
  const memLow = mem.available_mb != null && mem.total_mb != null && mem.available_mb / mem.total_mb < 0.1;
  const diskLow = s.disk.free_gb < 1;
  return (
    <>
      <Card title="Бот">
        <Row label="Работает" ok="up">{duration(now - s.started_at)} · с {dateTime(s.started_at)}</Row>
        <Row label="Счёт и режим" ok={s.paused ? "amber" : "up"}>{s.env} · {s.mode}{s.paused ? ` · пауза: ${s.paused}` : ""}</Row>
        <Row label="Проверка рынка" ok={scanLate ? "amber" : "up"}>
          {s.last_scan ? `была ${ago(s.last_scan, now)}` : "ещё не было"} · следующая через {duration(Math.max(0, s.next_scan - now))}
        </Row>
        <Row label="Bybit" ok={bybitOk ? "up" : s.bybit.ok_at ? "amber" : "down"}>
          {s.bybit.ok_at ? `ответил ${ago(s.bybit.ok_at, now)}` : "нет ответа"}
          {s.bybit.error_at && !bybitOk ? ` · ошибка ${ago(s.bybit.error_at, now)}` : ""}
        </Row>
        <Row label="Telegram" ok={tgOk ? "up" : "amber"}>{s.telegram.ok_at ? `на связи ${ago(s.telegram.ok_at, now)}` : "нет данных"}</Row>
        {s.bybit.error && !bybitOk && <p className="sys-error small">{s.bybit.error}</p>}
      </Card>
      <Card title="Сервер">
        <Row label="Версия" ok="up">{s.version}{s.built_at ? ` · собрана ${new Date(s.built_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}</Row>
        <Row label="Память" ok={memLow ? "amber" : "up"}>
          бот {mem.process_mb != null ? `${Math.round(mem.process_mb)} МБ` : "—"}
          {mem.total_mb != null ? ` · свободно ${mem.available_mb} из ${mem.total_mb} МБ` : ""}
        </Row>
        <Row label="Диск" ok={diskLow ? "amber" : "up"}>
          свободно {s.disk.free_gb.toFixed(1).replace(".", ",")} из {s.disk.total_gb.toFixed(0)} ГБ · данные {s.disk.data_mb.toFixed(1).replace(".", ",")} МБ
        </Row>
      </Card>
      <Card title="Последние ошибки" aside={<span className="muted small">{s.errors.length || "нет"}</span>}>
        {s.errors.length === 0
          ? <p className="muted small">Ошибок и предупреждений с момента запуска не было.</p>
          : (
            <ul className="error-list">
              {s.errors.map((e, i) => (
                <li key={i}>
                  <span className={`err-level ${e.level}`}>{e.level === "error" || e.level === "critical" ? "ошибка" : "внимание"}</span>
                  <span className="muted small">{dateTime(e.ts)} · {e.source}</span>
                  <p>{e.text}</p>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </>
  );
}

function Manage({ settings, users, run }: {
  settings: AdminSettings; users: number; run: (a: () => Promise<{ message: string }>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [text, setText] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  const changed = (Object.keys(draft) as (keyof AdminSettings)[]).filter((k) => draft[k] !== settings[k]);
  const set = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => setDraft({ ...draft, [k]: v });
  const save = () => void run(() => api.saveAdmin(Object.fromEntries(changed.map((k) => [k, draft[k]]))));
  const send = async () => {
    if (!text.trim() || !(await confirmAction(`Отправить сообщение всем пользователям (${users})?`))) return;
    await run(() => api.broadcast(text));
    setText("");
  };
  return (
    <>
      <Card title="Демо-счета">
        <div className="field">
          <div className="field-text"><strong>Регистрация новых</strong><span>Новые люди получают демо-счёт по /start</span></div>
          <Switch checked={draft.registration_open} label="Регистрация новых" onChange={(v) => set("registration_open", v)} />
        </div>
        <div className="field">
          <div className="field-text"><strong>Сообщать мне о новых</strong><span>Иначе — одной строкой в ежедневной сводке</span></div>
          <Switch checked={draft.notify_new_users} label="Сообщать о новых" onChange={(v) => set("notify_new_users", v)} />
        </div>
        <div className="field">
          <div className="field-text"><strong>Лимит пользователей</strong><span>Сервер 1,8 ГБ спокойно держит 100–200</span></div>
          <Stepper value={draft.max_users} min={1} max={1000} step={10} unit="" label="Лимит пользователей"
            onChange={(v) => set("max_users", v)} />
        </div>
        <div className="field">
          <div className="field-text"><strong>Стартовая сумма</strong><span>Для новых и сброшенных счетов</span></div>
          <Stepper value={draft.demo_start_usdt} min={100} max={1_000_000} step={500} unit=" $" label="Стартовая сумма"
            onChange={(v) => set("demo_start_usdt", v)} />
        </div>
        <Button variant="primary" disabled={!changed.length} onClick={save}>Сохранить</Button>
      </Card>
      <Card title="Рассылка" aside={<span className="muted small">{users} получат</span>}>
        <textarea className="broadcast" rows={4} maxLength={3500} placeholder="Сообщение всем пользователям в Telegram"
          value={text} onChange={(e) => setText(e.target.value)} aria-label="Текст рассылки" />
        <Button variant="primary" disabled={!text.trim() || !users} onClick={() => void send()}>Отправить всем</Button>
      </Card>
    </>
  );
}
