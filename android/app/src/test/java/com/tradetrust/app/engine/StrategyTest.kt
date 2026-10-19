package com.tradetrust.app.engine

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val H4 = 14_400_000L

private fun candles(closes: List<Double>, spread: Double = 0.01): List<Candle> = closes.mapIndexed { i, c ->
    val o = if (i == 0) c else closes[i - 1]
    Candle(i * H4, o, maxOf(o, c) * (1 + spread), minOf(o, c) * (1 - spread), c)
}

private fun linspace(a: Double, b: Double, n: Int) = List(n) { a + (b - a) * it / (n - 1) }

private val P = Params(fast = 3, slow = 6, atrPeriod = 3, atrMult = 2.0, fee = 0.0)

class StrategyTest {
    @Test
    fun flatMarketNoTrades() {
        val res = backtest(prepare(candles(List(50) { 100.0 }), P), P)
        assertTrue(res.trades.isEmpty())
        assertEquals(0.0, res.totalReturnPct, 1e-9)
    }

    @Test
    fun uptrendEntersAtNextOpen() {
        val c = candles(List(20) { 100.0 } + linspace(100.0, 200.0, 40), 0.001)
        val data = prepare(c, P)
        val res = backtest(data, P)
        val signal = data.crossUp.indexOfFirst { it }
        assertEquals(1, res.trades.size)
        assertEquals(c[signal + 1].time, res.trades[0].entryTime)
        assertEquals(c[signal + 1].open, res.trades[0].entryPrice, 0.0)
        assertNotNull(res.openTrade)
        assertTrue(res.totalReturnPct > 0)
    }

    @Test
    fun riskSizingCapsLossAtStop() {
        val p = P.copy(risk = 0.01)
        val c = candles(List(20) { 100.0 } + linspace(100.0, 130.0, 15) + List(10) { 60.0 }, 0.001)
        val t = backtest(prepare(c, p), p).trades.first { it.reason == "stop" }
        assertTrue((t.entryPrice - t.stop) * t.qty <= 0.01 + 1e-9)
    }

    @Test
    fun noLeverage() {
        val p = P.copy(atrMult = 0.1, risk = 0.5)
        val c = candles(List(20) { 100.0 } + linspace(100.0, 300.0, 60), 0.0001)
        backtest(prepare(c, p), p).trades.forEach { assertTrue(it.qty * it.entryPrice <= 1.0 + 1e-9) }
    }

    @Test
    fun btcRegimeHasNoLookahead() {
        val daily = List(260) { i -> Candle(i * DAY_MS, 100.0, 100.0, 100.0, if (i == 259) 1000.0 else 100.0) }
        val times = LongArray(12) { 259 * DAY_MS + it * H4 }
        val reg = btcRegime(daily, times, 200)
        assertFalse(reg.take(6).any { it })
        assertTrue(reg.drop(6).all { it })
    }

    @Test
    fun enterSignalSizesPositionByRisk() {
        val full = candles(List(20) { 100.0 } + linspace(100.0, 200.0, 40), 0.05)
        val signal = prepare(full, P).crossUp.indexOfFirst { it }
        val data = prepare(full.take(signal + 1), P)
        val s = evaluate("TEST", data, P, deposit = 1000.0, useFilter = false)
        assertEquals(Action.ENTER, s.action)
        assertEquals(10.0, s.riskUsd!!, 1e-6)
        assertEquals(s.price - 2 * data.atr.last(), s.stop!!, 1e-9)
    }
}

/** Kotlin-движок должен совпадать с tradetrust/backtest.py на реальных свечах SOL. */
class StrategyParityTest {
    private fun load(name: String): List<Candle> =
        javaClass.classLoader!!.getResource(name)!!.readText().trim().lines().map { line ->
            val f = line.split(",")
            Candle(f[0].toLong(), f[1].toDouble(), f[2].toDouble(), f[3].toDouble(), f[4].toDouble())
        }

    @Test
    fun matchesPython() {
        val sol = load("sol_4h.csv")
        val btc = load("btc_1d.csv")
        val expected = JSONObject(javaClass.classLoader!!.getResource("expected.json")!!.readText())
        for (name in expected.keys()) {
            val case = expected.getJSONObject(name)
            val ps = case.getJSONObject("params")
            val p = Params(fast = ps.getInt("fast"), slow = ps.getInt("slow"), atrMult = ps.getDouble("atr_mult"),
                allIn = ps.getBoolean("all_in"))
            val regime = if (ps.getBoolean("btc_filter")) btcRegime(btc, LongArray(sol.size) { sol[it].time }) else null
            val res = backtest(prepare(sol, p, regime), p)

            val trades = case.getJSONArray("trades")
            assertEquals("$name: число сделок", trades.length(), res.trades.size)
            for (k in 0 until trades.length()) {
                val e = trades.getJSONObject(k)
                val t = res.trades[k]
                assertEquals("$name #$k время входа", e.getLong("entry_time"), t.entryTime)
                assertEquals("$name #$k стоп", e.getDouble("stop"), t.stop, 1e-9 * t.stop)
                assertEquals("$name #$k кол-во", e.getDouble("qty"), t.qty, 1e-9 * t.qty)
                assertEquals("$name #$k причина", e.getString("reason"), t.reason)
                if (!e.isNull("exit")) assertEquals("$name #$k выход", e.getDouble("exit"), t.exitPrice!!, 1e-9)
            }
            assertEquals("$name доход", case.getDouble("return_pct"), res.totalReturnPct, 1e-6)
            assertEquals("$name просадка", case.getDouble("max_dd_pct"), res.maxDrawdownPct, 1e-6)
        }
    }
}
