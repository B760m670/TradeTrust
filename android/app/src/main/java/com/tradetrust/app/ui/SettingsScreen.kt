package com.tradetrust.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tradetrust.app.data.AppSettings
import com.tradetrust.app.data.Scanner
import com.tradetrust.app.data.Updater
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

@Composable
fun SettingsScreen(settings: AppSettings, modifier: Modifier, onSave: (AppSettings) -> Unit) {
    var deposit by remember(settings) { mutableStateOf(settings.deposit.toString()) }
    var risk by remember(settings) { mutableStateOf(settings.riskPct.toString()) }
    var atrMult by remember(settings) { mutableStateOf(settings.atrMult.toString()) }
    var fast by remember(settings) { mutableStateOf(settings.fast.toString()) }
    var slow by remember(settings) { mutableStateOf(settings.slow.toString()) }
    var coins by remember(settings) { mutableStateOf(settings.coins.joinToString(", ")) }
    var btcFilter by remember(settings) { mutableStateOf(settings.btcFilter) }
    var notifications by remember(settings) { mutableStateOf(settings.notifications) }

    val parsed = runCatching {
        val f = fast.toInt()
        val s = slow.toInt()
        require(f in 2 until s && s <= 400)
        AppSettings(
            deposit = deposit.replace(',', '.').toDouble().also { require(it > 0) },
            riskPct = risk.replace(',', '.').toDouble().also { require(it > 0 && it <= 10) },
            atrMult = atrMult.replace(',', '.').toDouble().also { require(it > 0) },
            fast = f, slow = s, btcFilter = btcFilter, notifications = notifications,
            coins = coins.split(',', ' ', ';').map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
                .also { require(it.isNotEmpty()) },
        )
    }.getOrNull()

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Настройки", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

        Field("Депозит, $", deposit, KeyboardType.Decimal) { deposit = it }
        Field("Риск на сделку, % депозита", risk, KeyboardType.Decimal) { risk = it }
        Text("1% — рекомендуемо. При 2% доход и просадки примерно вдвое больше.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

        Toggle("Уведомления о сигналах", "Проверка раз в час в фоне; уведомление только при ВХОДЕ или ВЫХОДЕ",
            notifications) { notifications = it }
        Toggle("Фильтр по биткоину", "Входить, только если BTC выше 200-дневной средней", btcFilter) { btcFilter = it }

        Text("Система", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field("EMA быстрая", fast, KeyboardType.Number, Modifier.weight(1f)) { fast = it }
            Field("EMA медленная", slow, KeyboardType.Number, Modifier.weight(1f)) { slow = it }
            Field("Стоп, ATR", atrMult, KeyboardType.Decimal, Modifier.weight(1f)) { atrMult = it }
        }
        Text("Проверено на истории: 20 / 50 / 2. Подбор других значений на тестах выигрыша не дал.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

        OutlinedTextField(coins, { coins = it }, label = { Text("Монеты (к USDT)") }, modifier = Modifier.fillMaxWidth())

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = parsed != null && parsed != settings, onClick = { parsed?.let(onSave) }) { Text("Сохранить") }
            TextButton(onClick = { onSave(AppSettings(deposit = parsed?.deposit ?: settings.deposit,
                notifications = notifications, coins = Scanner.DEFAULT_COINS)) }) { Text("По умолчанию") }
        }
        if (parsed == null) Text("Проверьте значения: числа больше нуля, быстрая EMA меньше медленной.",
            color = Down, style = MaterialTheme.typography.bodySmall)

        val update = viewModel<UpdateViewModel>()
        val us by update.state.collectAsStateWithLifecycle()
        Text("Приложение", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Версия ${Updater.currentVersion}", modifier = Modifier.weight(1f))
            TextButton(enabled = !us.checking, onClick = { update.check(manual = true) }) {
                Text(if (us.checking) "Проверяю…" else "Проверить обновления")
            }
        }
        us.lastCheckMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun Field(label: String, value: String, type: KeyboardType, modifier: Modifier = Modifier.fillMaxWidth(),
                  onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = modifier,
        keyboardOptions = KeyboardOptions(keyboardType = type))
}

@Composable
private fun Toggle(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, onChange)
    }
}
