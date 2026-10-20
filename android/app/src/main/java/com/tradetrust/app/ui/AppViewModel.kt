package com.tradetrust.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tradetrust.app.data.AppSettings
import com.tradetrust.app.data.JournalEntry
import com.tradetrust.app.data.JournalStore
import com.tradetrust.app.data.ScanResult
import com.tradetrust.app.data.Scanner
import com.tradetrust.app.data.SettingsStore
import com.tradetrust.app.work.SignalWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ScanState(val loading: Boolean = false, val result: ScanResult? = null, val error: String? = null)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val settingsStore = SettingsStore(app)
    private val journalStore = JournalStore(app)

    private val _settings = MutableStateFlow(settingsStore.load())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    private val _scan = MutableStateFlow(ScanState())
    val scan: StateFlow<ScanState> = _scan.asStateFlow()

    private val _journal = MutableStateFlow(journalStore.load())
    val journal: StateFlow<List<JournalEntry>> = _journal.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        if (_scan.value.loading) return
        _scan.value = _scan.value.copy(loading = true, error = null)
        viewModelScope.launch {
            _scan.value = runCatching { Scanner.scan(_settings.value) }.fold(
                { ScanState(result = it) },
                { ScanState(result = _scan.value.result, error = it.message ?: it.toString()) },
            )
        }
    }

    fun saveSettings(s: AppSettings) {
        val changedStrategy = s.copy(notifications = true) != _settings.value.copy(notifications = true)
        settingsStore.save(s)
        _settings.value = s
        if (s.notifications) SignalWorker.schedule(getApplication()) else SignalWorker.cancel(getApplication())
        if (changedStrategy) refresh()
    }

    fun upsertTrade(e: JournalEntry) {
        journalStore.upsert(e)
        _journal.value = journalStore.load()
    }

    fun deleteTrade(id: Long) {
        journalStore.delete(id)
        _journal.value = journalStore.load()
    }

    fun journalCsv(): String = journalStore.toCsv()
}
