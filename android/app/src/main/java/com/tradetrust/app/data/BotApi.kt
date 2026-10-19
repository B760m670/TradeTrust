package com.tradetrust.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Подключение к серверному боту (tradetrust/bot/api.py). */
data class BotConnection(val url: String = "", val token: String = "") {
    val configured get() = url.isNotBlank() && token.isNotBlank()
}

class BotConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("bot", Context.MODE_PRIVATE)
    fun load() = BotConnection(prefs.getString("url", "")!!, prefs.getString("token", "")!!)
    fun save(c: BotConnection) = prefs.edit().putString("url", c.url.trim().trimEnd('/')).putString("token", c.token.trim()).apply()
}

data class BotPosition(val coin: String, val qty: Double, val entry: Double, val stop: Double, val price: Double,
                       val pnl: Double, val openedAt: Long)

data class BotProposal(val id: String, val coin: String, val price: Double, val stop: Double, val qty: Double,
                       val risk: Double, val expiresAt: Long)

data class BotTrade(val coin: String, val qty: Double, val entry: Double, val exit: Double, val pnl: Double,
                    val r: Double?, val reason: String, val closedAt: Long)

data class BotEvent(val ts: Long, val level: String, val text: String)

data class BotStatus(
    val env: String,
    val mode: String,
    val paused: String?,
    val equity: Double,
    val free: Double,
    val unrealized: Double,
    val positions: List<BotPosition>,
    val proposals: List<BotProposal>,
    val trades: List<BotTrade>,
    val events: List<BotEvent>,
    val lastBar: Long,
)

class BotApi(private val conn: BotConnection) {

    suspend fun status(): BotStatus = withContext(Dispatchers.IO) { parse(request("GET", "/api/status")) }

    suspend fun confirm(id: String) = message("POST", "/api/proposals/$id/confirm")
    suspend fun reject(id: String) = message("POST", "/api/proposals/$id/reject")
    suspend fun setMode(mode: String) = message("POST", "/api/mode", JSONObject().put("mode", mode))
    suspend fun pause() = message("POST", "/api/pause")
    suspend fun resume() = message("POST", "/api/resume")
    suspend fun close(coin: String) = message("POST", "/api/positions/$coin/close")

    private suspend fun message(method: String, path: String, body: JSONObject? = null): String =
        withContext(Dispatchers.IO) { request(method, path, body).optString("message") }

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val c = URL(conn.url + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 60_000 // сделка на бирже может занять несколько секунд
        c.setRequestProperty("Authorization", "Bearer ${conn.token}")
        if (body != null || method == "POST") {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write((body ?: JSONObject()).toString().toByteArray()) }
        }
        try {
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "{}"
            if (code == 401) error("Неверный токен")
            if (code >= 400) error(runCatching { JSONObject(text).optString("error") }.getOrNull() ?: "HTTP $code")
            return JSONObject(text)
        } finally {
            c.disconnect()
        }
    }

    companion object {
        private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
        private fun JSONObject.optDoubleOrNull(k: String) = if (isNull(k) || !has(k)) null else getDouble(k)

        fun parse(o: JSONObject): BotStatus {
            val eq = o.getJSONObject("equity")
            return BotStatus(
                env = o.getString("env"),
                mode = o.getString("mode"),
                paused = if (o.isNull("paused")) null else o.optString("paused"),
                equity = eq.getDouble("total"),
                free = eq.getDouble("free"),
                unrealized = eq.optDouble("unrealized", 0.0),
                positions = o.getJSONArray("positions").objects().map {
                    BotPosition(it.getString("coin"), it.getDouble("qty"), it.getDouble("entry"), it.getDouble("stop"),
                        it.getDouble("price"), it.getDouble("pnl_usdt"), it.getLong("opened_at") * 1000)
                },
                proposals = o.getJSONArray("proposals").objects().map {
                    BotProposal(it.getString("id"), it.getString("coin"), it.getDouble("price"), it.getDouble("stop"),
                        it.getDouble("qty"), it.getDouble("risk_usdt"), it.getLong("expires_at") * 1000)
                },
                trades = o.getJSONArray("trades").objects().map {
                    BotTrade(it.getString("coin"), it.getDouble("qty"), it.getDouble("entry"), it.getDouble("exit"),
                        it.getDouble("pnl_usdt"), it.optDoubleOrNull("r"), it.getString("reason"), it.getLong("closed_at") * 1000)
                },
                events = o.getJSONArray("events").objects().map {
                    BotEvent(it.getLong("ts") * 1000, it.getString("level"), it.getString("text"))
                },
                lastBar = o.optLong("last_bar") * 1000,
            )
        }
    }
}
