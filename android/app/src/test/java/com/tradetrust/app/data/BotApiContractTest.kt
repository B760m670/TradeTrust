package com.tradetrust.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ответ /api/status настоящего Python-бота (scripts/make_api_fixture.py) должен разбираться приложением. */
class BotApiContractTest {
    @Test
    fun parsesServerStatus() {
        val json = JSONObject(javaClass.classLoader!!.getResource("bot_status.json")!!.readText())
        val s = BotApi.parse(json)
        assertEquals("paper", s.env)
        assertEquals("confirm", s.mode)
        assertNull(s.paused)
        assertTrue(s.equity > 0)
        assertEquals(listOf("SOL"), s.positions.map { it.coin })
        assertEquals(listOf("ETH"), s.proposals.map { it.coin })
        val t = s.trades.single()
        assertEquals("LINK", t.coin)
        assertEquals("stop", t.reason)
        assertTrue(t.pnl < 0 && t.r!! < 0)
        assertTrue(s.positions[0].stop < s.positions[0].entry)
        assertTrue(s.events.isNotEmpty())
        assertTrue(s.lastBar > 1_700_000_000_000)
    }
}
