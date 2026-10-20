package com.tradetrust.app.data

import android.content.Context
import com.tradetrust.app.engine.Params
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class AppSettings(
    val deposit: Double = 1000.0,
    val riskPct: Double = 1.0,
    val atrMult: Double = 2.0,
    val fast: Int = 20,
    val slow: Int = 50,
    val btcFilter: Boolean = false,
    val notifications: Boolean = true,
    val coins: List<String> = Scanner.DEFAULT_COINS,
) {
    fun params() = Params(fast = fast, slow = slow, atrMult = atrMult, risk = riskPct / 100)
}

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun load(): AppSettings {
        val d = AppSettings()
        return AppSettings(
            deposit = prefs.getFloat("deposit", d.deposit.toFloat()).toDouble(),
            riskPct = prefs.getFloat("riskPct", d.riskPct.toFloat()).toDouble(),
            atrMult = prefs.getFloat("atrMult", d.atrMult.toFloat()).toDouble(),
            fast = prefs.getInt("fast", d.fast),
            slow = prefs.getInt("slow", d.slow),
            btcFilter = prefs.getBoolean("btcFilter", d.btcFilter),
            notifications = prefs.getBoolean("notifications", d.notifications),
            coins = prefs.getString("coins", null)?.split(",")?.filter { it.isNotBlank() } ?: d.coins,
        )
    }

    fun save(s: AppSettings) {
        prefs.edit()
            .putFloat("deposit", s.deposit.toFloat())
            .putFloat("riskPct", s.riskPct.toFloat())
            .putFloat("atrMult", s.atrMult.toFloat())
            .putInt("fast", s.fast)
            .putInt("slow", s.slow)
            .putBoolean("btcFilter", s.btcFilter)
            .putBoolean("notifications", s.notifications)
            .putString("coins", s.coins.joinToString(","))
            .apply()
    }

    /** Уже отправленные уведомления, чтобы не повторять одно и то же. */
    fun wasNotified(key: String) = prefs.getStringSet("notified", emptySet())!!.contains(key)

    fun markNotified(key: String) {
        val set = prefs.getStringSet("notified", emptySet())!!.toMutableSet()
        set += key
        prefs.edit().putStringSet("notified", set.toList().takeLast(200).toSet()).apply()
    }
}

data class JournalEntry(
    val id: Long,
    val coin: String,
    val opened: Long,
    val entry: Double,
    val stop: Double,
    val qty: Double,
    val reason: String = "",
    val closed: Long? = null,
    val exit: Double? = null,
    val fees: Double = 0.0,
    val followedRules: Boolean = true,
    val mistake: String = "",
) {
    val isOpen get() = exit == null
    val riskUsd get() = (entry - stop) * qty
    val pnlUsd get() = exit?.let { (it - entry) * qty - fees }
    val r get() = pnlUsd?.let { if (riskUsd > 0) it / riskUsd else null }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("coin", coin); put("opened", opened); put("entry", entry); put("stop", stop)
        put("qty", qty); put("reason", reason); put("fees", fees); put("followedRules", followedRules)
        put("mistake", mistake)
        closed?.let { put("closed", it) }
        exit?.let { put("exit", it) }
    }

    companion object {
        fun fromJson(o: JSONObject) = JournalEntry(
            id = o.getLong("id"), coin = o.getString("coin"), opened = o.getLong("opened"),
            entry = o.getDouble("entry"), stop = o.getDouble("stop"), qty = o.getDouble("qty"),
            reason = o.optString("reason"),
            closed = if (o.has("closed")) o.getLong("closed") else null,
            exit = if (o.has("exit")) o.getDouble("exit") else null,
            fees = o.optDouble("fees", 0.0), followedRules = o.optBoolean("followedRules", true),
            mistake = o.optString("mistake"),
        )
    }
}

data class JournalStats(
    val closed: Int,
    val open: Int,
    val winPct: Double,
    val pnlUsd: Double,
    val avgR: Double?,
    val profitFactor: Double?,
    val rulesBroken: Int,
)

fun stats(entries: List<JournalEntry>): JournalStats {
    val closed = entries.filter { !it.isOpen }
    val pnl = closed.map { it.pnlUsd!! }
    val wins = pnl.filter { it > 0 }.sum()
    val losses = -pnl.filter { it <= 0 }.sum()
    val rs = closed.mapNotNull { it.r }
    return JournalStats(
        closed = closed.size,
        open = entries.size - closed.size,
        winPct = if (closed.isEmpty()) 0.0 else 100.0 * pnl.count { it > 0 } / closed.size,
        pnlUsd = pnl.sum(),
        avgR = if (rs.isEmpty()) null else rs.average(),
        profitFactor = if (losses > 0) wins / losses else null,
        rulesBroken = closed.count { !it.followedRules },
    )
}

/** Журнал сделок хранится файлом journal.json во внутренней памяти приложения. */
class JournalStore(context: Context) {
    private val file = File(context.filesDir, "journal.json")

    fun load(): List<JournalEntry> = if (!file.exists()) emptyList() else {
        val arr = JSONArray(file.readText())
        (0 until arr.length()).map { JournalEntry.fromJson(arr.getJSONObject(it)) }
    }

    fun save(entries: List<JournalEntry>) {
        val tmp = File(file.parentFile, "journal.json.tmp")
        tmp.writeText(JSONArray(entries.map { it.toJson() }).toString())
        tmp.renameTo(file)
    }

    fun upsert(e: JournalEntry) = save(load().filter { it.id != e.id } + e)

    fun delete(id: Long) = save(load().filter { it.id != id })

    /** Весь журнал в CSV — чтобы отправить в чат и разобрать сделки. */
    fun toCsv(): String = buildString {
        appendLine("coin,opened,entry,stop,qty,closed,exit,fees,pnl_usd,r,followed_rules,reason,mistake")
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
        for (e in load().sortedBy { it.opened }) {
            appendLine(listOf(e.coin, fmt.format(e.opened), e.entry, e.stop, e.qty,
                e.closed?.let { fmt.format(it) } ?: "", e.exit ?: "", e.fees,
                e.pnlUsd?.let { "%.2f".format(java.util.Locale.US, it) } ?: "",
                e.r?.let { "%.2f".format(java.util.Locale.US, it) } ?: "",
                if (e.followedRules) "yes" else "no",
                "\"${e.reason.replace("\"", "'")}\"", "\"${e.mistake.replace("\"", "'")}\"").joinToString(","))
        }
    }
}
