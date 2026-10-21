import { useEffect, useState } from "react";
import { api, type EditableSettings, type NumericSetting, type Status } from "../api";
import { BotState, EnvChip, ModeSwitch, PauseButton, type Act } from "../components/BotControls";
import { Stepper, Switch } from "../components/controls";
import { CheckIcon } from "../components/icons";
import { Button, Card } from "../components/ui";
import { usd } from "../format";
import { changedSettings, localTime } from "../logic";
import { confirmAction, haptic } from "../telegram";
import { THEME_OPTIONS, useTheme } from "../theme";

interface Field {
  key: NumericSetting;
  label: string;
  hint: string;
  step: number;
  unit: string;
}

const FIELDS: Field[] = [
  { key: "risk_pct", label: "Риск на сделку", hint: "Столько теряем, если сработает стоп", step: 0.25, unit: "%" },
  { key: "max_positions", label: "Позиций одновременно", hint: "Новые сделки не открываются сверх лимита", step: 1, unit: "" },
  { key: "max_position_pct", label: "Максимум в одной монете", hint: "Доля капитала на одну позицию", step: 5, unit: "%" },
  { key: "max_total_risk_pct", label: "Общий риск", hint: "Сумма рисков всех открытых позиций", step: 0.5, unit: "%" },
  { key: "daily_loss_limit_pct", label: "Дневной лимит убытка", hint: "После него бот ставит новые сделки на паузу", step: 0.5, unit: "%" },
  { key: "proposal_ttl_min", label: "Предложение действует", hint: "Режим «Вручную»: сколько ждать нажатия", step: 15, unit: " мин" },
];

const num = (x: number) => x.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const OFFSET_MIN = -new Date().getTimezoneOffset(); // часовой пояс телефона или компьютера

function CapitalInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value ? String(value) : "0");
  useEffect(() => setText(value ? String(value) : "0"), [value]);
  const commit = () => {
    const v = Number(text.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100) / 100);
    else setText(String(value));
  };
  return (
    <input className="money-input" inputMode="decimal" aria-label="Капитал бота, USDT" value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

function ThemePicker() {
  const { pref, setPref } = useTheme();
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Тема">
      {THEME_OPTIONS.map(([key, label]) => (
        <button key={key} role="radio" aria-checked={pref === key} className={`theme-option${pref === key ? " on" : ""}`}
          onClick={() => { haptic(); setPref(key); }}>
          <span className={`theme-preview pv-${key}`} aria-hidden="true"><i /><i /><i /></span>
          <span>{pref === key && <CheckIcon size={14} />}{label}</span>
        </button>
      ))}
    </div>
  );
}

const editableOf = (s: Status): EditableSettings => {
  const { atr_mult: _a, ema_fast: _f, ema_slow: _s, ...rest } = s.settings;
  return rest;
};

export function Settings({ status: s, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const saved = editableOf(s);
  const [edits, setEdits] = useState<Partial<EditableSettings>>({});
  const draft: EditableSettings = { ...saved, ...edits };
  const changes = changedSettings(draft, saved);
  const dirty = Object.keys(changes).length > 0;
  const riskConflict = draft.max_total_risk_pct < draft.risk_pct;
  const noCoins = draft.coins.length === 0;
  const held = new Set(s.positions.map((p) => p.coin));
  const set = <K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) =>
    setEdits((e) => ({ ...e, [key]: value }));
  const isChanged = (key: keyof EditableSettings) => key in changes;

  const toggleCoin = (coin: string) => {
    haptic();
    const on = new Set(draft.coins);
    if (on.has(coin)) on.delete(coin);
    else on.add(coin);
    set("coins", s.all_coins.filter((c) => on.has(c)));
  };

  const save = async () => {
    const lines = Object.keys(changes).length;
    if (!(await confirmAction(`Сохранить изменения (${lines})? Бот применит их сразу и пришлёт отчёт в Telegram.`))) return;
    if (await act(() => api.saveSettings(changes))) setEdits({});
  };
  const reset = async () => {
    if (!(await confirmAction("Вернуть все настройки к значениям из файла .env на сервере?"))) return;
    if (await act(api.resetSettings)) setEdits({});
  };

  return (
    <div className="settings">
      <header className="page-head">
        <h1>Настройки</h1>
        <span className="muted">Оформление, режим и лимиты бота</span>
      </header>

      <div className="settings-grid">
        <div className="settings-col">
          <Card title="Оформление">
            <ThemePicker />
            <p className="footnote">«Авто» — как тема Telegram. Выбор сохраняется для всех ваших устройств.</p>
          </Card>

          <Card title="Бот" aside={<EnvChip status={s} />}>
            <ModeSwitch status={s} busy={busy} act={act} />
            <div className="side-row">
              <BotState status={s} />
              <PauseButton status={s} busy={busy} act={act} />
            </div>
            <p className="footnote">Выходы по сигналу и стопы работают в любом режиме и на паузе.</p>
          </Card>

          <Card title="Ежедневная сводка">
            <div>
              <div className={`field${isChanged("daily_report") ? " changed" : ""}`}>
                <div className="field-text">
                  <strong>Присылать в Telegram</strong>
                  <span>Капитал, итог за сутки, позиции и сигналы</span>
                </div>
                <Switch checked={draft.daily_report} label="Ежедневная сводка" onChange={(v) => set("daily_report", v)} />
              </div>
              <div className={`field${isChanged("report_hour_utc") ? " changed" : ""}${draft.daily_report ? "" : " disabled"}`}>
                <div className="field-text"><strong>Время</strong><span>По вашим часам</span></div>
                <Stepper value={draft.report_hour_utc} min={0} max={23} step={1} unit="" label="Время сводки"
                  format={(h) => localTime(h, OFFSET_MIN)} onChange={(v) => set("report_hour_utc", v)} />
              </div>
            </div>
            <p className="footnote">Сводку можно запросить и в любой момент: команда /report.</p>
          </Card>

          <Card title="Система">
            <dl className="facts">
              <dt>Свечи</dt><dd>4 часа</dd>
              <dt>Вход</dt><dd>EMA {s.settings.ema_fast} пересекает EMA {s.settings.ema_slow} снизу вверх</dd>
              <dt>Стоп</dt><dd>вход − {num(s.settings.atr_mult)} × ATR</dd>
              <dt>Выход</dt><dd>EMA {s.settings.ema_fast} ниже EMA {s.settings.ema_slow} или стоп</dd>
            </dl>
            <p className="footnote">Параметры системы проверены на истории и меняются только в .env на сервере.</p>
          </Card>
        </div>

        <div className="settings-col">
          <Card title="Риск и лимиты">
            <div>
              {FIELDS.map((f) => {
                const lim = s.settings_limits[f.key];
                return (
                  <div key={f.key} className={`field${isChanged(f.key) ? " changed" : ""}`}>
                    <div className="field-text"><strong>{f.label}</strong><span>{f.hint}</span></div>
                    <Stepper value={draft[f.key]} min={lim.min} max={lim.max} step={f.step} unit={f.unit} label={f.label}
                      onChange={(v) => set(f.key, v)} />
                  </div>
                );
              })}
              <div className={`field${isChanged("capital_usdt") ? " changed" : ""}`}>
                <div className="field-text">
                  <strong>Капитал бота, USDT</strong>
                  <span>{draft.capital_usdt ? `Бот распоряжается ${usd(draft.capital_usdt)} USDT` : "0 — весь свободный USDT на счёте"}</span>
                </div>
                <CapitalInput value={draft.capital_usdt} onChange={(v) => set("capital_usdt", v)} />
              </div>
              <div className={`field${isChanged("trend_filter") ? " changed" : ""}`}>
                <div className="field-text">
                  <strong>Только монеты в росте</strong>
                  <span>Покупать, только если монета выросла за {draft.trend_days} дней. По истории 2022–2026 просадка
                    вдвое меньше</span>
                </div>
                <Switch checked={draft.trend_filter} label="Только монеты в росте" onChange={(v) => set("trend_filter", v)} />
              </div>
              <div className={`field${isChanged("trend_days") ? " changed" : ""}${draft.trend_filter ? "" : " disabled"}`}>
                <div className="field-text"><strong>Рост за</strong><span>Окно, за которое считается рост</span></div>
                <Stepper value={draft.trend_days} min={s.settings_limits.trend_days?.min ?? 30}
                  max={s.settings_limits.trend_days?.max ?? 160} step={10} unit=" дн" label="Рост за"
                  onChange={(v) => set("trend_days", v)} />
              </div>
              <div className={`field${isChanged("btc_filter") ? " changed" : ""}`}>
                <div className="field-text">
                  <strong>Пауза, когда BTC падает</strong>
                  <span>Новые сделки — только когда биткоин выше своей {draft.btc_days}-дневной средней. По истории
                    2022–2026 доход выше, просадка −28% вместо −35%</span>
                </div>
                <Switch checked={draft.btc_filter} label="Пауза, когда BTC падает" onChange={(v) => set("btc_filter", v)} />
              </div>
              <div className={`field${isChanged("btc_days") ? " changed" : ""}${draft.btc_filter ? "" : " disabled"}`}>
                <div className="field-text"><strong>Средняя BTC</strong><span>За сколько дней считать среднюю цену</span></div>
                <Stepper value={draft.btc_days} min={s.settings_limits.btc_days?.min ?? 20}
                  max={s.settings_limits.btc_days?.max ?? 200} step={10} unit=" дн" label="Средняя BTC"
                  onChange={(v) => set("btc_days", v)} />
              </div>
            </div>
            {riskConflict && <p className="tone-down small">Общий риск не может быть меньше риска на сделку.</p>}
          </Card>

          <Card title="Монеты" aside={<span className="muted small">{draft.coins.length} из {s.all_coins.length}</span>}>
            <div className="coin-grid-pick">
              {s.all_coins.map((c) => (
                <button key={c} className={`coin-pick${draft.coins.includes(c) ? " on" : ""}`}
                  aria-pressed={draft.coins.includes(c)} onClick={() => toggleCoin(c)}
                  title={held.has(c) ? "Открыта позиция: выход отслеживается, даже если монету выключить" : undefined}>
                  {held.has(c) && <span className="dot dot-up" />}{c}
                </button>
              ))}
            </div>
            <div className="coin-tools">
              <button className="link-btn" onClick={() => set("coins", [...s.all_coins])}>Выбрать все</button>
              <button className="link-btn" onClick={() => set("coins", [])}>Снять все</button>
            </div>
            {noCoins
              ? <p className="tone-down small">Выберите хотя бы одну монету.</p>
              : <p className="footnote">Бот ищет входы только по выбранным монетам. Открытые позиции сопровождаются до выхода.</p>}
          </Card>

          <button className="link-btn" disabled={busy} onClick={() => void reset()}>
            {s.account === "demo" ? "Сбросить к значениям по умолчанию" : "Сбросить к значениям из .env"}
          </button>
        </div>
      </div>

      {dirty && (
        <div className="save-bar" role="region" aria-label="Несохранённые изменения">
          <span>Изменено: {Object.keys(changes).length}</span>
          <Button onClick={() => setEdits({})}>Отменить</Button>
          <Button variant="primary" disabled={busy || riskConflict || noCoins} onClick={() => void save()}>Сохранить</Button>
        </div>
      )}
    </div>
  );
}
