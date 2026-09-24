package io.wasmer.shell

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.test.*
import kotlin.time.Duration.Companion.seconds

class ShellTest {
    @Test fun ghosttyUnicodeAnsiResizeAndKeyboard() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.showTerminal()
                val terminal = activity.terminal
                val encoded = "\u001b[31mKotlin 🦀 café\u001b[0m\n".encodeToByteArray()
                // Split inside a multibyte Unicode character across calls into Ghostty.
                encoded.forEach { terminal.feed(byteArrayOf(it)) }
                assertTrue(terminal.screenText().contains("Kotlin 🦀 café"))
                val input = mutableListOf<Byte>()
                terminal.onInput = { input.addAll(it.toList()) }
                terminal.key(0)
                assertEquals("\u001b[A", input.toByteArray().decodeToString())
                input.clear()
                val connection = terminal.onCreateInputConnection(android.view.inputmethod.EditorInfo())
                connection.setComposingText("hé", 1)
                connection.commitText("héllo", 1)
                connection.deleteSurroundingText(1, 0)
                assertEquals("héllo\u007f", input.toByteArray().decodeToString())
                input.clear()
                terminal.onKeyDown(android.view.KeyEvent.KEYCODE_C, android.view.KeyEvent(
                    0, 0, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_C, 0,
                    android.view.KeyEvent.META_CTRL_ON))
                assertContentEquals(byteArrayOf(3), input.toByteArray())
                assertTrue(terminal.columns > 0 && terminal.rows > 0)
            }
            instrumentation.waitForIdleSync()
        }
    }

    @Test fun pythonNodeAndClangInRealTerminal() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("integration") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val cases = listOf(
            Triple("python", "python -c \"print('ANDROID' + '_PYTHON_OK')\"\n", "ANDROID_PYTHON_OK"),
            Triple("node", "node -e \"console.log('ANDROID' + '_NODE_OK')\"\n", "ANDROID_NODE_OK"),
            Triple("clang", "clang hello.c -o hello.wasm && ./hello.wasm 'ANDROID_C_OK'\n", "Hello, ANDROID_C_OK!"),
        )
        for ((example, command, expected) in cases) {
            android.util.Log.i("WasmerShellTest", "Starting $example")
            val intent = Intent(context, MainActivity::class.java).putExtra("example", example)
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                await(240) { var ready = false; scenario.onActivity {
                    assertNull(it.sessionFailure, "$example failed to start: ${it.sessionFailure}")
                    ready = it.sessionReady
                }; ready }
                android.util.Log.i("WasmerShellTest", "$example shell ready")
                scenario.onActivity { it.terminal.input(command.encodeToByteArray()) }
                await(180) { var text = ""; scenario.onActivity { text = it.terminal.screenText() }; text.contains(expected) }
                android.util.Log.i("WasmerShellTest", "$example command passed")
                if (example == "python") {
                    scenario.onActivity {
                        it.terminal.input(("python -c \"open('android-preview.txt','w').write('ANDROID_PREVIEW_OK')\" && " +
                            "python -m http.server 8000 --bind 127.0.0.1\n").encodeToByteArray())
                    }
                    await(60) {
                        withContext(Dispatchers.IO) {
                            val connection = java.net.URL("http://127.0.0.1:8000/android-preview.txt")
                                .openConnection() as java.net.HttpURLConnection
                            connection.connectTimeout = 1000; connection.readTimeout = 1000
                            try { connection.inputStream.bufferedReader().use { it.readText() } == "ANDROID_PREVIEW_OK" }
                            catch (_: java.io.IOException) { false }
                            finally { connection.disconnect() }
                        }
                    }
                    scenario.onActivity { it.openPreview(8000) }
                    await(30) { var loaded = false; scenario.onActivity {
                        val web = findWebView(it.window.decorView)
                        loaded = web?.url == "http://127.0.0.1:8000/" && web.progress == 100
                    }; loaded }
                    scenario.onActivity { it.showTerminal() }
                    android.util.Log.i("WasmerShellTest", "Python HTTP and WebView preview passed")
                    scenario.onActivity { it.terminal.input(byteArrayOf(3)) }
                    scenario.onActivity { it.terminal.input("printf '%s%s\\n' PREVIEW _STOPPED\n".encodeToByteArray()) }
                    await(30) { var text = ""; scenario.onActivity { text = it.terminal.screenText() }; text.contains("PREVIEW_STOPPED") }
                }
                scenario.onActivity { it.terminal.input("exit\n".encodeToByteArray()) }
                await(30) { var ready = true; scenario.onActivity { ready = it.sessionReady }; !ready }
            }
        }
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }

    private suspend fun await(seconds: Int, predicate: suspend () -> Boolean) {
        withTimeout(seconds.seconds) { while (!predicate()) delay(200) }
    }
}
