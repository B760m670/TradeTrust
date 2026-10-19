package com.tradetrust.app.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.tradetrust.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class UpdateInfo(val versionCode: Int, val name: String, val notes: String, val apkUrl: String, val size: Long)

/**
 * Обновления из GitHub Releases. CI публикует каждую сборку из main как релиз build-N
 * с файлом TradeTrust-N.apk, где N совпадает с versionCode.
 */
object Updater {
    private const val LATEST = "https://api.github.com/repos/B760m670/TradeTrust/releases/latest"

    val currentVersion: Int get() = BuildConfig.VERSION_CODE

    suspend fun check(): UpdateInfo? = withContext(Dispatchers.IO) {
        val c = URL(LATEST).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (c.responseCode == 404) return@withContext null // релизов ещё нет
            if (c.responseCode != 200) error("GitHub: HTTP ${c.responseCode}")
            parse(JSONObject(c.inputStream.bufferedReader().readText()))?.takeIf { it.versionCode > currentVersion }
        } finally {
            c.disconnect()
        }
    }

    fun parse(release: JSONObject): UpdateInfo? {
        val version = release.optString("tag_name").removePrefix("build-").toIntOrNull() ?: return null
        val assets = release.optJSONArray("assets") ?: return null
        val apk = (0 until assets.length()).map { assets.getJSONObject(it) }
            .firstOrNull { it.optString("name").endsWith(".apk") } ?: return null
        return UpdateInfo(version, release.optString("name", "TradeTrust $version"), release.optString("body").trim(),
            apk.getString("browser_download_url"), apk.optLong("size"))
    }

    suspend fun download(context: Context, info: UpdateInfo, onProgress: (Float) -> Unit): File =
        withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // старые APK не копим
            val target = File(dir, "TradeTrust-${info.versionCode}.apk")
            val tmp = File(dir, "download.tmp")
            var url = URL(info.apkUrl)
            var conn: HttpURLConnection
            // GitHub отдаёт файл через редирект на другой домен — проходим его вручную
            while (true) {
                conn = url.openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 15_000
                conn.readTimeout = 60_000
                if (conn.responseCode in 300..399) {
                    url = URL(url, conn.getHeaderField("Location"))
                    conn.disconnect()
                    continue
                }
                break
            }
            try {
                if (conn.responseCode != 200) error("Загрузка: HTTP ${conn.responseCode}")
                val total = conn.contentLengthLong.takeIf { it > 0 } ?: info.size
                conn.inputStream.use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var done = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            if (total > 0) onProgress(done.toFloat() / total)
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
            if (!tmp.renameTo(target)) error("Не удалось сохранить файл")
            target
        }

    /** Разрешено ли приложению ставить APK (Android 8+ спрашивает один раз). */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun openInstallPermissionSettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun install(context: Context, apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
