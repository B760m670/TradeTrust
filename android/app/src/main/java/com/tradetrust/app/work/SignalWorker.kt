package com.tradetrust.app.work

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.tradetrust.app.R
import com.tradetrust.app.data.Scanner
import com.tradetrust.app.data.SettingsStore
import com.tradetrust.app.engine.Action
import com.tradetrust.app.ui.MainActivity
import java.util.concurrent.TimeUnit

/**
 * Раз в час проверяет сигналы в фоне. Свечи 4ч закрываются в 00/04/08/12/16/20 UTC,
 * уведомление по каждой свече приходит один раз — повторы отсекаются по ключу.
 */
class SignalWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val store = SettingsStore(applicationContext)
        val settings = store.load()
        if (!settings.notifications) return Result.success()
        val scan = runCatching { Scanner.scan(settings) }.getOrElse { return Result.retry() }
        for (c in scan.coins) {
            val s = c.signal
            if (s.action != Action.ENTER && s.action != Action.EXIT) continue
            val key = "${s.coin}:${s.barCloseTime}:${s.action}"
            if (store.wasNotified(key)) continue
            notify(applicationContext, "${s.action.label}: ${s.coin} по ~${com.tradetrust.app.engine.fmt(s.price)}",
                s.detail, key.hashCode())
            store.markNotified(key)
        }
        return Result.success()
    }

    companion object {
        private const val WORK = "signal-check"
        const val CHANNEL = "signals"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<SignalWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(WORK)

        fun createChannel(context: Context) {
            val channel = NotificationChannel(CHANNEL, "Сигналы", NotificationManager.IMPORTANCE_HIGH)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        fun notify(context: Context, title: String, text: String, id: Int) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED && android.os.Build.VERSION.SDK_INT >= 33) return
            val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(id, n)
        }
    }
}
