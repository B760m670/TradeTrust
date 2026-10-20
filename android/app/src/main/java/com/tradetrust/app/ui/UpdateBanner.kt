package com.tradetrust.app.ui

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tradetrust.app.data.UpdateInfo
import com.tradetrust.app.data.Updater
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

data class UpdateState(
    val available: UpdateInfo? = null,
    val progress: Float? = null,   // идёт загрузка
    val downloaded: File? = null,
    val checking: Boolean = false,
    val error: String? = null,
    val dismissed: Boolean = false,
    val lastCheckMessage: String? = null,
)

class UpdateViewModel(app: Application) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(UpdateState())
    val state = _state.asStateFlow()

    fun check(manual: Boolean = false) {
        if (_state.value.checking || _state.value.progress != null) return
        _state.value = _state.value.copy(checking = true, error = null)
        viewModelScope.launch {
            _state.value = runCatching { Updater.check() }.fold(
                { info ->
                    _state.value.copy(checking = false, available = info,
                        dismissed = if (manual) false else _state.value.dismissed,
                        lastCheckMessage = if (info == null) "Установлена последняя версия" else null)
                },
                { _state.value.copy(checking = false, lastCheckMessage = if (manual) "Не удалось проверить: ${it.message}" else null) },
            )
        }
    }

    fun update() {
        val ctx = getApplication<Application>()
        val info = _state.value.available ?: return
        if (!Updater.canInstall(ctx)) {
            Updater.openInstallPermissionSettings(ctx)
            return
        }
        _state.value.downloaded?.takeIf { it.exists() }?.let { Updater.install(ctx, it); return }
        _state.value = _state.value.copy(progress = 0f, error = null)
        viewModelScope.launch {
            runCatching { Updater.download(ctx, info) { p -> _state.value = _state.value.copy(progress = p) } }
                .onSuccess { file ->
                    _state.value = _state.value.copy(progress = null, downloaded = file)
                    Updater.install(ctx, file)
                }
                .onFailure { _state.value = _state.value.copy(progress = null, error = it.message ?: it.toString()) }
        }
    }

    fun dismiss() {
        _state.value = _state.value.copy(dismissed = true)
    }
}

/** Плашка «Доступно обновление» над содержимым приложения. */
@Composable
fun UpdateBanner(vm: UpdateViewModel = viewModel()) {
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.check() }

    val info = s.available ?: return
    if (s.dismissed && s.progress == null) return
    Card(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = Accent.copy(alpha = 0.18f)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Доступно обновление", fontWeight = FontWeight.Bold)
                    Text("Версия ${info.versionCode} (у вас ${Updater.currentVersion})",
                        style = MaterialTheme.typography.bodySmall)
                }
                if (s.progress == null) {
                    TextButton(onClick = vm::dismiss) { Text("Позже") }
                    Button(onClick = vm::update) { Text("Обновить") }
                }
            }
            if (info.notes.isNotBlank()) Text(info.notes.lines().first(), style = MaterialTheme.typography.bodySmall,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            s.progress?.let {
                LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                Text("Загрузка ${(it * 100).toInt()}%", style = MaterialTheme.typography.bodySmall)
            }
            if (!Updater.canInstall(LocalContext.current) && s.progress == null) {
                Text("Android попросит разрешить установку из TradeTrust — включите и вернитесь, затем снова «Обновить».",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            s.error?.let { Text("Ошибка: $it", color = Down, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
