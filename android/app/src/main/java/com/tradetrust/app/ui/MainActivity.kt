package com.tradetrust.app.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tradetrust.app.data.JournalEntry
import com.tradetrust.app.data.SettingsStore
import com.tradetrust.app.work.SignalWorker

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        SignalWorker.createChannel(this)
        if (SettingsStore(this).load().notifications) SignalWorker.schedule(this)
        if (Build.VERSION.SDK_INT >= 33) {
            registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
                .launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent { TradeTrustTheme { App() } }
    }
}

private enum class Tab(val title: String) { SIGNALS("Сигналы"), JOURNAL("Журнал"), SETTINGS("Настройки") }

@Composable
private fun App(vm: AppViewModel = viewModel()) {
    val settings by vm.settings.collectAsStateWithLifecycle()
    val scan by vm.scan.collectAsStateWithLifecycle()
    val journal by vm.journal.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.SIGNALS) }
    var openCoin by rememberSaveable { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf<JournalEntry?>(null) }

    BackHandler(enabled = openCoin != null) { openCoin = null }

    val coinView = openCoin?.let { c -> scan.result?.coins?.firstOrNull { it.signal.coin == c } }
    if (coinView != null) {
        CoinScreen(coinView, settings, onBack = { openCoin = null }, onRecord = { entry ->
            draft = entry
            openCoin = null
            tab = Tab.JOURNAL
        })
        return
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            Icon(when (t) {
                                Tab.SIGNALS -> Icons.Filled.List
                                Tab.JOURNAL -> Icons.Filled.Edit
                                Tab.SETTINGS -> Icons.Filled.Settings
                            }, contentDescription = null)
                        },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { pad ->
        val m = Modifier.padding(pad)
        when (tab) {
            Tab.SIGNALS -> SignalsScreen(scan, settings, m, onRefresh = vm::refresh, onOpen = { openCoin = it })
            Tab.JOURNAL -> JournalScreen(journal, draft, m, onDraftConsumed = { draft = null },
                onSave = vm::upsertTrade, onDelete = vm::deleteTrade, csv = vm::journalCsv)
            Tab.SETTINGS -> SettingsScreen(settings, m, onSave = vm::saveSettings)
        }
    }
}
