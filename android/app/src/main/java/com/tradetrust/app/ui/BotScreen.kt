package com.tradetrust.app.ui

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tradetrust.app.data.BotApi
import com.tradetrust.app.data.BotConnection
import com.tradetrust.app.data.BotConnectionStore
import com.tradetrust.app.data.BotStatus
import com.tradetrust.app.engine.fmt
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class BotUiState(
    val loading: Boolean = false,
    val status: BotStatus? = null,
    val error: String? = null,
    val message: String? = null,
    val busy: Boolean = false,
)

class BotViewModel(app: Application) : AndroidViewModel(app) {
    private val connStore = BotConnectionStore(app)
    private val _conn = MutableStateFlow(connStore.load())
    val conn = _conn.asStateFlow()
    private val _state = MutableStateFlow(BotUiState())
    val state = _state.asStateFlow()

    private fun api() = BotApi(_conn.value)

    fun saveConnection(c: BotConnection) {
        connStore.save(c)
        _conn.value = connStore.load()
        _state.value = BotUiState()
        refresh()
    }

    fun refresh() {
        if (!_conn.value.configured || _state.value.loading) return
        _state.value = _state.value.copy(loading = true)
        viewModelScope.launch {
            _state.value = runCatching { api().status() }.fold(
                { _state.value.copy(loading = false, status = it, error = null) },
                { _state.value.copy(loading = false, error = it.message ?: it.toString()) },
            )
        }
    }

    /** Действие на сервере, затем обновление статуса. */
    fun act(block: suspend BotApi.() -> String) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, message = null)
        viewModelScope.launch {
            val msg = runCatching { api().block() }.getOrElse { "Ошибка: ${it.message}" }
            _state.value = _state.value.copy(busy = false, message = msg)
            refresh()
        }
    }

    fun dismissMessage() {
        _state.value = _state.value.copy(message = null)
    }
}

private val timeFmt = SimpleDateFormat("dd.MM HH:mm", Locale.getDefault())
private val MODES = listOf("signals" to "Сигналы", "confirm" to "Подтверждение", "auto" to "Авто")
private val ENV_NAMES = mapOf("paper" to "бумажный счёт", "demo" to "демо Bybit", "testnet" to "тестнет Bybit",
    "mainnet" to "РЕАЛЬНЫЙ счёт")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotScreen(modifier: Modifier, vm: BotViewModel = viewModel()) {
    val conn by vm.conn.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf<String?>(null) }
    var confirmAuto by remember { mutableStateOf(false) }

    if (!conn.configured || editing) {
        ConnectionForm(conn, modifier, onSave = { vm.saveConnection(it); editing = false },
            onCancel = if (conn.configured) ({ editing = false }) else null)
        return
    }

    LaunchedEffect(conn) {
        while (true) { // пока экран открыт — обновляем раз в 30 секунд
            vm.refresh()
            delay(30_000)
        }
    }

    PullToRefreshBox(isRefreshing = state.loading, onRefresh = vm::refresh, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Бот", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f))
                    TextButton(onClick = { editing = true }) { Text("Сервер") }
                }
                state.error?.let { Text("Нет связи с сервером: $it", color = Down, style = MaterialTheme.typography.bodySmall) }
            }
            val s = state.status ?: return@LazyColumn
            item { AccountCard(s, state.busy, onMode = { if (it == "auto") confirmAuto = true else vm.act { setMode(it) } },
                onPause = { vm.act { if (s.paused == null) pause() else resume() } }) }

            if (s.proposals.isNotEmpty()) item { Section("Ждут подтверждения") }
            items(s.proposals, key = { "p" + it.id }) { p ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("ВХОД ${p.coin}", fontWeight = FontWeight.Bold, color = Up)
                        Text("Купить ${fmt(p.qty)} ${p.coin} по ~${fmt(p.price)} ≈ ${"%,.2f".format(p.qty * p.price)} USDT")
                        Text("Стоп ${fmt(p.stop)} (−${"%.1f".format((1 - p.stop / p.price) * 100)}%), риск ${"%,.2f".format(p.risk)} USDT")
                        Text("Действует до ${timeFmt.format(Date(p.expiresAt))}", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(enabled = !state.busy, onClick = { vm.act { confirm(p.id) } },
                                colors = ButtonDefaults.buttonColors(containerColor = Up)) { Text("Купить") }
                            OutlinedButton(enabled = !state.busy, onClick = { vm.act { reject(p.id) } }) { Text("Пропустить") }
                        }
                    }
                }
            }

            item { Section("Позиции") }
            if (s.positions.isEmpty()) item { Muted("Открытых позиций нет.") }
            items(s.positions, key = { "pos" + it.coin }) { p ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.coin, fontWeight = FontWeight.Bold)
                            Text("${fmt(p.qty)} шт · вход ${fmt(p.entry)} · сейчас ${fmt(p.price)}",
                                style = MaterialTheme.typography.bodySmall)
                            Text("стоп ${fmt(p.stop)} · с ${timeFmt.format(Date(p.openedAt))}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("${"%+,.2f".format(p.pnl)} $", color = if (p.pnl >= 0) Up else Down, fontWeight = FontWeight.Bold)
                            TextButton(enabled = !state.busy, onClick = { confirmClose = p.coin }) { Text("Закрыть") }
                        }
                    }
                }
            }

            item { Section("Сделки бота") }
            if (s.trades.isEmpty()) item { Muted("Закрытых сделок пока нет.") }
            items(s.trades.take(15), key = { "t" + it.coin + it.closedAt }) { t ->
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text("${t.coin} · ${timeFmt.format(Date(t.closedAt))} · ${reasonName(t.reason)}",
                        style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    Text("${"%+,.2f".format(t.pnl)} $" + (t.r?.let { " (${"%+.2f".format(it)}R)" } ?: ""),
                        color = if (t.pnl >= 0) Up else Down, style = MaterialTheme.typography.bodySmall)
                }
            }

            item { Section("События") }
            items(s.events.take(15), key = { "e" + it.ts + it.text.hashCode() }) { e ->
                Text("${timeFmt.format(Date(e.ts))}  ${e.text}", style = MaterialTheme.typography.bodySmall,
                    color = if (e.level == "error") Down else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    state.message?.let { msg ->
        AlertDialog(onDismissRequest = vm::dismissMessage, confirmButton = { TextButton(vm::dismissMessage) { Text("OK") } },
            text = { Text(msg) })
    }
    confirmClose?.let { coin ->
        AlertDialog(
            onDismissRequest = { confirmClose = null },
            title = { Text("Закрыть $coin?") },
            text = { Text("Бот отменит стоп и продаст позицию по рынку.") },
            confirmButton = { TextButton({ confirmClose = null; vm.act { close(coin) } }) { Text("Закрыть", color = Down) } },
            dismissButton = { TextButton({ confirmClose = null }) { Text("Отмена") } },
        )
    }
    if (confirmAuto) {
        AlertDialog(
            onDismissRequest = { confirmAuto = false },
            title = { Text("Автоматический режим") },
            text = { Text("Бот будет сам покупать по сигналам, без подтверждения. Стопы и лимиты риска продолжают работать.") },
            confirmButton = { TextButton({ confirmAuto = false; vm.act { setMode("auto") } }) { Text("Включить") } },
            dismissButton = { TextButton({ confirmAuto = false }) { Text("Отмена") } },
        )
    }
}

@Composable
private fun AccountCard(s: BotStatus, busy: Boolean, onMode: (String) -> Unit, onPause: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(ENV_NAMES[s.env] ?: s.env, color = if (s.env == "mainnet") Down else Accent,
                fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            Text("${"%,.2f".format(s.equity)} USDT", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("свободно ${"%,.2f".format(s.free)} · в позициях ${"%+,.2f".format(s.unrealized)} $",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                MODES.forEach { (key, label) ->
                    FilterChip(selected = s.mode == key, enabled = !busy, onClick = { if (s.mode != key) onMode(key) },
                        label = { Text(label) })
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (s.paused != null) "⏸ Пауза: ${s.paused}" else "▶ Работает",
                    color = if (s.paused != null) Amber else Up, modifier = Modifier.weight(1f))
                OutlinedButton(enabled = !busy, onClick = onPause) { Text(if (s.paused != null) "Продолжить" else "Пауза") }
            }
            if (s.lastBar > 0) Text("Последняя свеча: ${timeFmt.format(Date(s.lastBar + 4 * 3_600_000))}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ConnectionForm(conn: BotConnection, modifier: Modifier, onSave: (BotConnection) -> Unit, onCancel: (() -> Unit)?) {
    var url by remember { mutableStateOf(conn.url.ifBlank { "https://" }) }
    var token by remember { mutableStateOf(conn.token) }
    Column(modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Подключение к боту", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Muted("Адрес сервера и токен выводит установщик в конце (deploy/install.sh). " +
            "Их же можно посмотреть в файле /opt/tradetrust/.env (DOMAIN и API_TOKEN).")
        OutlinedTextField(url, { url = it.trim() }, label = { Text("Адрес сервера") }, singleLine = true,
            modifier = Modifier.fillMaxWidth())
        OutlinedTextField(token, { token = it.trim() }, label = { Text("Токен") }, singleLine = true,
            modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = url.startsWith("https://") && url.length > 10 && token.length >= 16,
                onClick = { onSave(BotConnection(url, token)) }) { Text("Подключить") }
            if (onCancel != null) TextButton(onClick = onCancel) { Text("Отмена") }
        }
        if (!url.startsWith("https://")) Text("Нужен адрес с https:// — токен нельзя передавать без шифрования.",
            color = Down, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Section(title: String) {
    Text(title, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun Muted(text: String) {
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
}

private fun reasonName(r: String) = when {
    r == "stop" -> "стоп"
    r == "signal" -> "сигнал"
    r == "manual" -> "вручную"
    else -> r
}
