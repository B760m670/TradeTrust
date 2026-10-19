package com.tradetrust.app.engine

/** Свеча; time — время открытия в миллисекундах UTC. */
data class Candle(
    val time: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
)

/** EMA как pandas ewm(span, adjust=false, min_periods=period): первые period-1 значений — NaN. */
fun ema(values: DoubleArray, period: Int): DoubleArray = ewm(values, 2.0 / (period + 1), period)

/** ATR со сглаживанием Уайлдера. */
fun atr(candles: List<Candle>, period: Int = 14): DoubleArray {
    val tr = DoubleArray(candles.size) { i ->
        val c = candles[i]
        if (i == 0) c.high - c.low
        else {
            val prev = candles[i - 1].close
            maxOf(c.high - c.low, kotlin.math.abs(c.high - prev), kotlin.math.abs(c.low - prev))
        }
    }
    return ewm(tr, 1.0 / period, period)
}

fun sma(values: DoubleArray, period: Int): DoubleArray {
    val out = DoubleArray(values.size) { Double.NaN }
    var sum = 0.0
    for (i in values.indices) {
        sum += values[i]
        if (i >= period) sum -= values[i - period]
        if (i >= period - 1) out[i] = sum / period
    }
    return out
}

private fun ewm(values: DoubleArray, alpha: Double, minPeriods: Int): DoubleArray {
    val out = DoubleArray(values.size) { Double.NaN }
    var y = Double.NaN
    for (i in values.indices) {
        y = if (i == 0) values[0] else (1 - alpha) * y + alpha * values[i]
        if (i >= minPeriods - 1) out[i] = y
    }
    return out
}

/**
 * true, если BTC закрыл предыдущий день выше SMA(period).
 * Значение дня D известно только после его закрытия, поэтому оно действует с D + 1 сутки.
 */
fun btcRegime(btcDaily: List<Candle>, times: LongArray, period: Int = 200): BooleanArray {
    val closes = DoubleArray(btcDaily.size) { btcDaily[it].close }
    val avg = sma(closes, period)
    val out = BooleanArray(times.size)
    var j = -1
    for (i in times.indices) {
        while (j + 1 < btcDaily.size && btcDaily[j + 1].time + DAY_MS <= times[i]) j++
        out[i] = j >= 0 && !avg[j].isNaN() && closes[j] > avg[j]
    }
    return out
}

const val DAY_MS = 86_400_000L
