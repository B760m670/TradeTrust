package com.tradetrust.app.engine

/**
 * Трендовая система EMA fast/slow, только покупки, без плеча.
 * Логика повторяет tradetrust/backtest.py — расхождения ловит StrategyParityTest.
 */
data class Params(
    val fast: Int = 20,
    val slow: Int = 50,
    val atrPeriod: Int = 14,
    val atrMult: Double = 2.0,
    val risk: Double = 0.01,
    val allIn: Boolean = false,
    val fee: Double = 0.001,
)

data class Trade(
    val entryTime: Long,
    val entryPrice: Double,
    val stop: Double,
    val qty: Double,
    var exitTime: Long? = null,
    var exitPrice: Double? = null,
    var reason: String = "",
)

class Prepared(
    val candles: List<Candle>,
    val emaFast: DoubleArray,
    val emaSlow: DoubleArray,
    val atr: DoubleArray,
    val crossUp: BooleanArray,
    val trendDown: BooleanArray,
    val regimeOk: BooleanArray,
)

class BacktestResult(val equity: DoubleArray, val trades: List<Trade>, val openTrade: Trade?) {
    val totalReturnPct: Double
        get() = if (equity.isEmpty()) 0.0 else (equity.last() / equity.first() - 1) * 100

    val maxDrawdownPct: Double
        get() {
            var peak = Double.NEGATIVE_INFINITY
            var dd = 0.0
            for (e in equity) {
                peak = maxOf(peak, e)
                dd = minOf(dd, e / peak - 1)
            }
            return dd * 100
        }

    val winRatePct: Double
        get() {
            val closed = trades.filter { it.exitPrice != null }
            return if (closed.isEmpty()) 0.0 else 100.0 * closed.count { it.exitPrice!! > it.entryPrice } / closed.size
        }
}

fun prepare(candles: List<Candle>, p: Params, regime: BooleanArray? = null): Prepared {
    val closes = DoubleArray(candles.size) { candles[it].close }
    val f = ema(closes, p.fast)
    val s = ema(closes, p.slow)
    val a = atr(candles, p.atrPeriod)
    val n = candles.size
    val above = BooleanArray(n) { f[it] > s[it] } // NaN даёт false, как в pandas
    val valid = BooleanArray(n) { !s[it].isNaN() }
    val crossUp = BooleanArray(n) { i -> above[i] && !(if (i == 0) true else above[i - 1]) && valid[i] }
    val trendDown = BooleanArray(n) { i -> !above[i] && valid[i] }
    return Prepared(candles, f, s, a, crossUp, trendDown, regime ?: BooleanArray(n) { true })
}

fun backtest(data: Prepared, p: Params, from: Int = 0, capital: Double = 1.0): BacktestResult {
    val c = data.candles
    var cash = capital
    var qty = 0.0
    var trade: Trade? = null
    val trades = mutableListOf<Trade>()
    var pendingEntry = false
    var pendingExit = false
    var stopDist = Double.NaN
    val equity = DoubleArray(c.size - from)

    for (i in from until c.size) {
        val bar = c[i]
        // 1) исполнение решений, принятых на закрытии прошлой свечи
        val t0 = trade
        if (pendingExit && t0 != null) {
            cash += qty * bar.open * (1 - p.fee)
            t0.exitTime = bar.time; t0.exitPrice = bar.open; t0.reason = "signal"
            trade = null; qty = 0.0
        } else if (pendingEntry && t0 == null) {
            if (stopDist > 0) {
                val maxQty = cash / (bar.open * (1 + p.fee))
                qty = if (p.allIn) maxQty else minOf(maxQty, cash * p.risk / stopDist)
                cash -= qty * bar.open * (1 + p.fee)
                trade = Trade(bar.time, bar.open, bar.open - stopDist, qty).also { trades += it }
            }
        }
        pendingEntry = false
        pendingExit = false

        // 2) стоп внутри свечи; гэп ниже стопа — выход по открытию
        val t1 = trade
        if (t1 != null && bar.low <= t1.stop) {
            val px = minOf(bar.open, t1.stop)
            cash += qty * px * (1 - p.fee)
            t1.exitTime = bar.time; t1.exitPrice = px; t1.reason = "stop"
            trade = null; qty = 0.0
        }

        // 3) сигналы на закрытии
        if (trade != null && data.trendDown[i]) {
            pendingExit = true
        } else if (trade == null && data.crossUp[i] && data.regimeOk[i] && data.atr[i] > 0) {
            pendingEntry = true
            stopDist = p.atrMult * data.atr[i]
        }
        equity[i - from] = cash + qty * bar.close
    }
    return BacktestResult(equity, trades, trade)
}

enum class Action(val label: String, val order: Int) {
    ENTER("ВХОД", 0), EXIT("ВЫХОД", 1), HOLD("ДЕРЖАТЬ", 2), SKIP("пропуск", 3), WAIT("ждать", 4)
}

/** Что делать на следующей свече после последней закрытой. */
data class Signal(
    val coin: String,
    val price: Double,
    val action: Action,
    val detail: String,
    val barCloseTime: Long,
    val entry: Double? = null,
    val stop: Double? = null,
    val qty: Double? = null,
    val riskUsd: Double? = null,
)

fun evaluate(coin: String, data: Prepared, p: Params, deposit: Double, useFilter: Boolean): Signal {
    val c = data.candles
    val i = c.lastIndex
    val res = backtest(data, p)
    val price = c[i].close
    val barClose = c[i].time + (c[i].time - c[i - 1].time)
    val open = res.openTrade
    return when {
        open != null && data.trendDown[i] -> Signal(coin, price, Action.EXIT,
            "EMA ${p.fast} ушла ниже EMA ${p.slow} — продать по рынку", barClose, stop = open.stop)
        open != null -> Signal(coin, price, Action.HOLD,
            "вход ${fmt(open.entryPrice)}, стоп ${fmt(open.stop)}", barClose, open.entryPrice, open.stop)
        data.crossUp[i] && data.regimeOk[i] -> {
            val dist = p.atrMult * data.atr[i]
            val qty = minOf(deposit * p.risk / dist, deposit / price)
            Signal(coin, price, Action.ENTER,
                "купить ${fmt(qty)} (~$${"%,.0f".format(qty * price)}), стоп ${fmt(price - dist)}",
                barClose, price, price - dist, qty, qty * dist)
        }
        data.crossUp[i] && useFilter -> Signal(coin, price, Action.SKIP,
            "пересечение вверх, но BTC ниже 200-дневной средней", barClose)
        else -> Signal(coin, price, Action.WAIT,
            if (data.trendDown[i]) "тренд вниз, сигнала нет" else "тренд вверх, ждём нового пересечения", barClose)
    }
}

/** Цена с разумным числом значащих цифр: 81880.8, 0.19200, 1.1340. */
fun fmt(x: Double): String = if (x >= 1000) "%.1f".format(x) else "%.4g".format(x)
