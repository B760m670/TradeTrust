package com.tradetrust.app.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tradetrust.app.data.JournalEntry
import com.tradetrust.app.data.stats
import com.tradetrust.app.engine.fmt
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val dateFmt = SimpleDateFormat("dd.MM.yy HH:mm", Locale.getDefault())

@Composable
fun JournalScreen(
    entries: List<JournalEntry>,
    draft: JournalEntry?,
    modifier: Modifier,
    onDraftConsumed: () -> Unit,
    onSave: (JournalEntry) -> Unit,
    onDelete: (Long) -> Unit,
    csv: () -> String,
) {
    var editing by remember { mutableStateOf<JournalEntry?>(null) }
    var closing by remember { mutableStateOf<JournalEntry?>(null) }
    val context = LocalContext.current

    LaunchedEffect(draft) {
        if (draft != null) { editing = draft; onDraftConsumed() }
    }

    Scaffold(
        modifier = modifier,
        floatingActionButton = {
            FloatingActionButton(onClick = {
                val now = System.currentTimeMillis()
                editing = JournalEntry(id = now, coin = "", opened = now, entry = 0.0, stop = 0.0, qty = 0.0)
            }) { Icon(Icons.Filled.Add, "Добавить сделку") }
        },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Журнал сделок", style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    IconButton(onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, "Журнал сделок TradeTrust")
                            putExtra(Intent.EXTRA_TEXT, csv())
                        }
                        context.startActivity(Intent.createChooser(send, "Отправить журнал"))
                    }) { Icon(Icons.Filled.Share, "Отправить журнал") }
                }
                StatsCard(entries)
            }
            if (entries.isEmpty()) item {
                Text("Пока пусто. Откройте монету с сигналом «ВХОД» и нажмите «Записать сделку», " +
                    "или добавьте сделку кнопкой +.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(entries.sortedWith(compareBy({ !it.isOpen }, { -it.opened })), key = { it.id }) { e ->
                TradeCard(e, onClick = { if (e.isOpen) closing = e else editing = e })
            }
        }
    }

    editing?.let { e ->
        EditDialog(e, onDismiss = { editing = null }, onSave = { onSave(it); editing = null },
            onDelete = if (entries.any { it.id == e.id }) ({ onDelete(e.id); editing = null }) else null)
    }
    closing?.let { e ->
        CloseDialog(e, onDismiss = { closing = null }, onEdit = { closing = null; editing = e },
            onSave = { onSave(it); closing = null })
    }
}

@Composable
private fun StatsCard(entries: List<JournalEntry>) {
    val s = stats(entries)
    Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Закрыто: ${s.closed} · открыто: ${s.open}")
            if (s.closed > 0) {
                Text("Итог: ${"%+,.2f".format(s.pnlUsd)} $", color = if (s.pnlUsd >= 0) Up else Down,
                    fontWeight = FontWeight.Bold)
                Text("Прибыльных: ${"%.0f".format(s.winPct)}%" +
                    (s.avgR?.let { " · средний R: ${"%+.2f".format(it)}" } ?: "") +
                    (s.profitFactor?.let { " · PF: ${"%.2f".format(it)}" } ?: ""))
                Text("Нарушений правил: ${s.rulesBroken}", color = if (s.rulesBroken > 0) Amber else Color.Unspecified)
            }
            Text("R — результат в долях риска: +2R значит заработали вдвое больше, чем рисковали.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun TradeCard(e: JournalEntry, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(e.coin, fontWeight = FontWeight.Bold)
                Text("${dateFmt.format(Date(e.opened))} · вход ${fmt(e.entry)} · стоп ${fmt(e.stop)} · ${fmt(e.qty)} шт",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!e.isOpen) Text("выход ${fmt(e.exit!!)} · ${e.closed?.let { dateFmt.format(Date(it)) } ?: ""}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (e.isOpen) Text("открыта · закрыть", color = Accent, style = MaterialTheme.typography.labelMedium)
            else {
                val pnl = e.pnlUsd!!
                Column(horizontalAlignment = Alignment.End) {
                    Text("${"%+,.2f".format(pnl)} $", color = if (pnl >= 0) Up else Down, fontWeight = FontWeight.Bold)
                    e.r?.let { Text("${"%+.2f".format(it)}R", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}

@Composable
private fun NumberField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(value, { onChange(it.replace(',', '.')) }, label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
}

private fun Double.field() = if (this == 0.0) "" else this.toBigDecimal().stripTrailingZeros().toPlainString()

@Composable
private fun EditDialog(e: JournalEntry, onDismiss: () -> Unit, onSave: (JournalEntry) -> Unit, onDelete: (() -> Unit)?) {
    var coin by remember { mutableStateOf(e.coin) }
    var entry by remember { mutableStateOf(e.entry.field()) }
    var stop by remember { mutableStateOf(e.stop.field()) }
    var qty by remember { mutableStateOf(e.qty.field()) }
    var reason by remember { mutableStateOf(e.reason) }
    var exit by remember { mutableStateOf(e.exit?.field() ?: "") }
    var fees by remember { mutableStateOf(e.fees.field()) }
    var mistake by remember { mutableStateOf(e.mistake) }
    val valid = coin.isNotBlank() && entry.toDoubleOrNull() != null && stop.toDoubleOrNull() != null &&
        qty.toDoubleOrNull() != null && (exit.isBlank() || exit.toDoubleOrNull() != null)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (onDelete == null) "Новая сделка" else "Сделка ${e.coin}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(coin, { coin = it.uppercase().trim() }, label = { Text("Монета") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth())
                NumberField("Цена входа", entry) { entry = it }
                NumberField("Стоп-лосс", stop) { stop = it }
                NumberField("Количество", qty) { qty = it }
                OutlinedTextField(reason, { reason = it }, label = { Text("Почему вошёл") }, modifier = Modifier.fillMaxWidth())
                if (!e.isOpen) {
                    NumberField("Цена выхода", exit) { exit = it }
                    NumberField("Комиссии, $", fees) { fees = it }
                    OutlinedTextField(mistake, { mistake = it }, label = { Text("Ошибка / вывод") },
                        modifier = Modifier.fillMaxWidth())
                }
            }
        },
        confirmButton = {
            TextButton(enabled = valid, onClick = {
                onSave(e.copy(coin = coin, entry = entry.toDouble(), stop = stop.toDouble(), qty = qty.toDouble(),
                    reason = reason, exit = exit.toDoubleOrNull() ?: e.exit, fees = fees.toDoubleOrNull() ?: 0.0,
                    mistake = mistake))
            }) { Text("Сохранить") }
        },
        dismissButton = {
            Row {
                if (onDelete != null) TextButton(onClick = onDelete) { Text("Удалить", color = Down) }
                TextButton(onClick = onDismiss) { Text("Отмена") }
            }
        },
    )
}

@Composable
private fun CloseDialog(e: JournalEntry, onDismiss: () -> Unit, onEdit: () -> Unit, onSave: (JournalEntry) -> Unit) {
    var exit by remember { mutableStateOf("") }
    var fees by remember { mutableStateOf("") }
    var followed by remember { mutableStateOf(true) }
    var mistake by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Закрыть сделку ${e.coin}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Вход ${fmt(e.entry)}, стоп ${fmt(e.stop)}, ${fmt(e.qty)} шт", style = MaterialTheme.typography.bodySmall)
                NumberField("Цена выхода", exit) { exit = it }
                NumberField("Комиссии, $", fees) { fees = it }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(followed, { followed = it })
                    Text("Действовал по правилам")
                }
                OutlinedTextField(mistake, { mistake = it }, label = { Text("Ошибка / вывод") },
                    modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = exit.toDoubleOrNull() != null, onClick = {
                onSave(e.copy(exit = exit.toDouble(), closed = System.currentTimeMillis(),
                    fees = fees.toDoubleOrNull() ?: 0.0, followedRules = followed, mistake = mistake))
            }) { Text("Закрыть сделку") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onEdit) { Text("Изменить") }
                TextButton(onClick = onDismiss) { Text("Отмена") }
            }
        },
    )
}
