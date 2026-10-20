package com.tradetrust.app.data

import com.tradetrust.app.engine.Candle
import com.tradetrust.app.engine.Params
import com.tradetrust.app.engine.Prepared
import com.tradetrust.app.engine.Signal
import com.tradetrust.app.engine.btcRegime
import com.tradetrust.app.engine.evaluate
import com.tradetrust.app.engine.prepare
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL

/** Публичные свечи Binance, ключи API не нужны. */
object Binance {
    private const val BASE = "https://data-api.binance.vision/api/v3/klines"

    fun klines(symbol: String, interval: String, limit: Int = 1000): List<Candle> {
        val conn = URL("$BASE?symbol=$symbol&interval=$interval&limit=$limit").openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        try {
            if (conn.responseCode != 200) error("Binance $symbol: HTTP ${conn.responseCode}")
            val rows = JSONArray(conn.inputStream.bufferedReader().readText())
            val now = System.currentTimeMillis()
            return (0 until rows.length()).map { rows.getJSONArray(it) }
                .filter { it.getLong(6) < now } // последняя свеча ещё не закрыта
                .map { Candle(it.getLong(0), it.getString(1).toDouble(), it.getString(2).toDouble(),
                    it.getString(3).toDouble(), it.getString(4).toDouble()) }
        } finally {
            conn.disconnect()
        }
    }
}

data class CoinView(val signal: Signal, val data: Prepared)

data class ScanResult(val coins: List<CoinView>, val errors: List<String>, val time: Long)

object Scanner {
    val DEFAULT_COINS = listOf(
        "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "BNB", "TRX",
        "DOT", "LTC", "BCH", "NEAR", "UNI", "ATOM", "XLM", "ETC", "FIL", "AAVE",
        "APT", "OP", "ARB", "INJ", "SUI",
    )

    suspend fun scan(settings: AppSettings): ScanResult = withContext(Dispatchers.IO) {
        val p = settings.params()
        val btcDaily = if (settings.btcFilter) Binance.klines("BTCUSDT", "1d", 400) else emptyList()
        val gate = Semaphore(5)
        val results = coroutineScope {
            settings.coins.map { coin ->
                async {
                    gate.withPermit {
                        runCatching {
                            val candles = Binance.klines("${coin}USDT", "4h", 1000)
                            val regime = if (settings.btcFilter)
                                btcRegime(btcDaily, LongArray(candles.size) { candles[it].time }) else null
                            val data = prepare(candles, p, regime)
                            CoinView(evaluate(coin, data, p, settings.deposit, settings.btcFilter), data)
                        }.recoverCatching { throw IllegalStateException("$coin: ${it.message}", it) }
                    }
                }
            }.awaitAll()
        }
        ScanResult(
            coins = results.mapNotNull { it.getOrNull() }
                .sortedWith(compareBy({ it.signal.action.order }, { it.signal.coin })),
            errors = results.mapNotNull { it.exceptionOrNull()?.message },
            time = System.currentTimeMillis(),
        )
    }
}
