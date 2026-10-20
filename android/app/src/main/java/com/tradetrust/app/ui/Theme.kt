package com.tradetrust.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.tradetrust.app.engine.Action

val Up = Color(0xFF1FA971)
val Down = Color(0xFFE5484D)
val Accent = Color(0xFF3B82F6)
val Amber = Color(0xFFE2A336)

fun actionColor(a: Action): Color = when (a) {
    Action.ENTER -> Up
    Action.EXIT -> Down
    Action.HOLD -> Accent
    Action.SKIP -> Amber
    Action.WAIT -> Color.Gray
}

@Composable
fun TradeTrustTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme())
        darkColorScheme(primary = Accent, onPrimary = Color.White, background = Color(0xFF0E1116), surface = Color(0xFF0E1116),
            surfaceVariant = Color(0xFF1A1F27))
    else lightColorScheme(primary = Accent, onPrimary = Color.White)
    MaterialTheme(colorScheme = scheme, content = content)
}
