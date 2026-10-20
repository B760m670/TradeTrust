package com.tradetrust.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdaterTest {
    private fun release(tag: String, assets: String) = JSONObject("""
        {"tag_name": "$tag", "name": "TradeTrust 42", "body": "Add bot tab\n\nDetails",
         "assets": $assets}
    """.trimIndent())

    @Test
    fun parsesReleasePublishedByCi() {
        val info = Updater.parse(release("build-42", """[
            {"name": "notes.txt", "size": 1, "browser_download_url": "https://x/notes.txt"},
            {"name": "TradeTrust-42.apk", "size": 6890863,
             "browser_download_url": "https://github.com/B760m670/TradeTrust/releases/download/build-42/TradeTrust-42.apk"}
        ]"""))!!
        assertEquals(42, info.versionCode)
        assertEquals("https://github.com/B760m670/TradeTrust/releases/download/build-42/TradeTrust-42.apk", info.apkUrl)
        assertEquals(6890863L, info.size)
        assertEquals("Add bot tab", info.notes.lines().first())
    }

    @Test
    fun ignoresForeignTagsAndReleasesWithoutApk() {
        assertNull(Updater.parse(release("v1.0", """[{"name": "a.apk", "size": 1, "browser_download_url": "u"}]""")))
        assertNull(Updater.parse(release("build-7", "[]")))
    }
}
