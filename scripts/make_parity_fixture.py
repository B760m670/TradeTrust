"""Готовит данные для StrategyParityTest: реальные свечи и результаты Python-бэктеста.

Kotlin-движок в android/ должен давать те же сделки, что tradetrust/backtest.py.
Запуск из корня репозитория: python -m scripts.make_parity_fixture
"""
import json
from pathlib import Path

from tradetrust import backtest as bt
from tradetrust.data import load_candles
from tradetrust.indicators import btc_regime

OUT = Path(__file__).resolve().parent.parent / "android/app/src/test/resources"

CASES = {
    "default": (bt.Params(), False),
    "btc_filter": (bt.Params(), True),
    "all_in_10_100_3": (bt.Params(fast=10, slow=100, atr_mult=3.0, sizing="all"), False),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    coin = load_candles("SOLUSDT", "4h", "2024-01-01", refresh=False).iloc[:1500]
    btc = load_candles("BTCUSDT", "1d", "2023-01-01", refresh=False)
    btc = btc[btc.index <= coin.index[-1]]

    def dump(df, name):
        ms = [int(t.timestamp() * 1000) for t in df.index]
        rows = [f"{t},{o!r},{h!r},{l!r},{c!r}" for t, o, h, l, c in
                zip(ms, df["open"], df["high"], df["low"], df["close"])]
        (OUT / name).write_text("\n".join(rows) + "\n")

    dump(coin, "sol_4h.csv")
    dump(btc, "btc_1d.csv")

    expected = {}
    for name, (p, use_filter) in CASES.items():
        regime = btc_regime(btc, coin.index) if use_filter else None
        res = bt.run(coin, p, regime)
        expected[name] = {
            "params": {"fast": p.fast, "slow": p.slow, "atr_mult": p.atr_mult, "all_in": p.sizing == "all",
                       "btc_filter": use_filter},
            "return_pct": res.total_return,
            "max_dd_pct": res.max_drawdown,
            "trades": [{"entry_time": int(t.entry_time.timestamp() * 1000), "entry": t.entry_price,
                        "stop": t.stop, "qty": t.qty, "exit": t.exit_price, "reason": t.reason}
                       for t in res.trades],
        }
        print(f"{name}: {len(res.trades)} trades, {res.total_return:.2f}%")
    (OUT / "expected.json").write_text(json.dumps(expected, indent=1))


if __name__ == "__main__":
    main()
