package com.tradetrust.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tradetrust.app.data.AppSettings
import com.tradetrust.app.data.CoinView
import com.tradetrust.app.data.JournalEntry
import com.tradetrust.app.engine.Action
import com.tradetrust.app.engine.backtest
import com.tradetrust.app.engine.fmt

private const val CHART_BARS = 120

@Composable
fun CoinScreen(cv: CoinView, settings: AppSettings, onBack: () -> Unit, onRecord: (JournalEntry) -> Unit) {
    val s = cv.signal
    val p = settings.params()
    val bt = remember(cv) { backtest(cv.data, p, from = p.slow) }
    val hold = remember(cv) {
        val c = cv.data.candles
        (c.last().close / c[p.slow].open - 1) * 100
    }
    val days = (cv.data.candles.size - p.slow) / 6

    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Назад") }
                Text("${s.coin}/USDT", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f))
                ActionChip(s.action)
            }
            Text("${fmt(s.price)} · ${s.detail}", style = MaterialTheme.typography.bodyLarge)

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    PriceChart(cv, s.stop, Modifier.fillMaxWidth().height(240.dp))
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Legend(MaterialTheme.colorScheme.onSurface, "цена")
                        Legend(Accent, "EMA ${p.fast}")
                        Legend(Amber, "EMA ${p.slow}")
                        if (s.stop != null) Legend(Down, "стоп")
                    }
                }
            }

            if (s.action == Action.ENTER && s.qty != null) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("План сделки", fontWeight = FontWeight.Bold)
                        Text("Купить: ${fmt(s.qty)} ${s.coin} ≈ $${"%,.2f".format(s.qty * s.price)}")
                        Text("Вход: по рынку ~${fmt(s.price)}")
                        Text("Стоп-лосс: ${fmt(s.stop!!)} (−${"%.1f".format((1 - s.stop / s.price) * 100)}%)")
                        Text("Риск: $${"%,.2f".format(s.riskUsd)} = ${settings.riskPct}% депозита")
                        Text("Выход: когда EMA ${p.fast} опустится ниже EMA ${p.slow}, или по стопу",
                            style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Как система работала на этой монете (~$days дн.)", fontWeight = FontWeight.Bold)
                    Text("Система: ${"%+.1f".format(bt.totalReturnPct)}%, просадка ${"%.1f".format(bt.maxDrawdownPct)}%")
                    Text("Купить и держать: ${"%+.1f".format(hold)}%")
                    Text("Сделок: ${bt.trades.size}, прибыльных ${"%.0f".format(bt.winRatePct)}%")
                    Text("Короткий период — для ориентира. Полная проверка — в Python-части проекта.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            if (s.action == Action.ENTER || s.action == Action.HOLD) {
                Button(onClick = {
                    onRecord(JournalEntry(
                        id = System.currentTimeMillis(), coin = s.coin, opened = System.currentTimeMillis(),
                        entry = s.entry ?: s.price, stop = s.stop ?: 0.0, qty = s.qty ?: 0.0,
                        reason = "EMA ${p.fast}/${p.slow} 4ч",
                    ))
                }, modifier = Modifier.fillMaxWidth()) { Text("Записать сделку в журнал") }
            }
        }
    }
}

@Composable
private fun Legend(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(10.dp)) { drawCircle(color) }
        Spacer(Modifier.size(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun PriceChart(cv: CoinView, stop: Double?, modifier: Modifier) {
    val priceColor = MaterialTheme.colorScheme.onSurface
    val gridColor = MaterialTheme.colorScheme.outlineVariant
    val d = cv.data
    val from = (d.candles.size - CHART_BARS).coerceAtLeast(0)
    val closes = d.candles.subList(from, d.candles.size).map { it.close }
    val fast = (from until d.candles.size).map { d.emaFast[it] }
    val slow = (from until d.candles.size).map { d.emaSlow[it] }
    val all = closes + fast.filter { !it.isNaN() } + slow.filter { !it.isNaN() } + listOfNotNull(stop)
    val lo = all.min()
    val hi = all.max()

    Canvas(modifier) {
        val dx = size.width / (closes.size - 1).coerceAtLeast(1)
        fun y(v: Double) = (size.height * (1 - (v - lo) / (hi - lo).coerceAtLeast(1e-12))).toFloat()
        for (k in 0..3) {
            val gy = size.height * k / 3
            drawLine(gridColor, Offset(0f, gy), Offset(size.width, gy), strokeWidth = 1f)
        }
        fun line(values: List<Double>, color: Color, width: Float) {
            val path = Path()
            var started = false
            values.forEachIndexed { i, v ->
                if (v.isNaN()) return@forEachIndexed
                if (!started) { path.moveTo(i * dx, y(v)); started = true } else path.lineTo(i * dx, y(v))
            }
            drawPath(path, color, style = Stroke(width))
        }
        line(closes, priceColor, 3f)
        line(fast, Accent, 2.5f)
        line(slow, Amber, 2.5f)
        if (stop != null) {
            drawLine(Down, Offset(0f, y(stop)), Offset(size.width, y(stop)), strokeWidth = 2f,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 8f)))
        }
    }
}
