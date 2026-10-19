package com.tradetrust.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tradetrust.app.data.AppSettings
import com.tradetrust.app.engine.Action
import com.tradetrust.app.engine.fmt
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignalsScreen(
    state: ScanState,
    settings: AppSettings,
    modifier: Modifier,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
) {
    PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text("Сигналы · 4ч", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                val r = state.result
                val sub = when {
                    r == null && state.loading -> "Загружаю свечи…"
                    r == null -> "Потяните вниз, чтобы загрузить"
                    else -> {
                        val bar = r.coins.firstOrNull()?.signal?.barCloseTime
                        val df = SimpleDateFormat("dd.MM HH:mm", Locale.getDefault())
                        "Свеча закрылась ${bar?.let { df.format(Date(it)) } ?: "—"} · депозит $${"%,.0f".format(settings.deposit)}" +
                            " · риск ${settings.riskPct}%" + if (settings.btcFilter) " · фильтр BTC" else ""
                    }
                }
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.error?.let {
                    Text("Ошибка: $it", color = Down, style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 4.dp))
                }
                state.result?.errors?.takeIf { it.isNotEmpty() }?.let {
                    Text("Не загрузились: ${it.joinToString("; ")}", color = Amber,
                        style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
                }
                Spacer(Modifier.padding(4.dp))
            }
            items(state.result?.coins ?: emptyList(), key = { it.signal.coin }) { cv ->
                val s = cv.signal
                Card(Modifier.fillMaxWidth().clickable { onOpen(s.coin) }) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.width(76.dp)) {
                            Text(s.coin, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                            Text(fmt(s.price), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(s.detail, style = MaterialTheme.typography.bodyMedium)
                        }
                        Spacer(Modifier.width(8.dp))
                        ActionChip(s.action)
                    }
                }
            }
            item {
                Text("Это результат правил системы, а не рекомендация. Сначала — демо-счёт.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

@Composable
fun ActionChip(a: Action) {
    val color = actionColor(a)
    Box(Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 4.dp)) {
        Text(a.label, color = color, fontWeight = if (a.order <= 2) FontWeight.Bold else FontWeight.Normal,
            style = MaterialTheme.typography.labelMedium)
    }
}
