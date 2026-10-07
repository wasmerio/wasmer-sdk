package io.wasmer.shell

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.graphics.Color
import android.view.*
import android.webkit.*
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.caverock.androidsvg.SVG
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Native Android counterpart of the iOS picker, terminal, keyboard bar and server preview. */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var root: LinearLayout
    private lateinit var body: FrameLayout
    private lateinit var status: TextView
    private lateinit var keys: LinearLayout
    private lateinit var loading: LinearLayout
    private lateinit var loadingText: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var retry: Button
    lateinit var terminal: TerminalView; private set
    private var session: ShellSession? = null
    private var selected: ShellExample? = null
    private var browser: WebView? = null
    private var transition: Job? = null
    private val transitionLock = Mutex()
    private val examples by lazy { ShellExample.load(this) }
    val sessionReady get() = session?.isReady == true
    val sessionFailure get() = session?.failure
    private val muted = 0xff8f8b9d.toInt()
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xff09090d.toInt()) }
        // Respect status/navigation bars and the IME on Android's edge-to-edge window.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), 0, dp(4), 0) }
        header.addView(assetImage("wasmer-logo.svg").apply { contentDescription = "Wasmer" }, LinearLayout.LayoutParams(dp(100), dp(20)))
        header.addView(TextView(this).apply { text = ".Android"; textSize = 14f; setTextColor(muted); gravity = Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(56), 1f))
        header.addView(button("▦", "Examples") { showPicker() })
        header.addView(button("↻", "Restart session") { openExample(selected) })
        header.addView(button("⌨", "Show keyboard") { showTerminal(); terminal.keyboard() })
        root.addView(header)
        status = TextView(this).apply {
            text = "Choose a workspace"; textSize = 12f; setTextColor(muted)
            maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(16), dp(4), dp(16), dp(8))
            setOnClickListener { sessionFailure?.let { AlertDialog.Builder(this@MainActivity)
                .setTitle("Session error").setMessage(it.message).setPositiveButton("OK", null).show() } }
        }
        root.addView(status)
        body = FrameLayout(this); root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))
        terminal = TerminalView(this)
        keys = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        listOf("Esc" to 7, "Tab" to 6, "↑" to 0, "↓" to 1, "←" to 2, "→" to 3).forEach { (name, key) ->
            keys.addView(button(name, name) { terminal.key(key) }, LinearLayout.LayoutParams(0, dp(46), 1f))
        }
        keys.addView(button("^C", "Interrupt") { terminal.input(byteArrayOf(3)) }, LinearLayout.LayoutParams(0, dp(46), 1f))
        keys.addView(button("^D", "End of input") { terminal.input(byteArrayOf(4)) }, LinearLayout.LayoutParams(0, dp(46), 1f))
        root.addView(keys)
        val footer = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        footer.addView(TextView(this).apply { text = "  On-device · Memory workspace"; textSize = 11f; setTextColor(muted); gravity = Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(44), 1f))
        footer.addView(button("Preview", "Open server preview") { promptPreview() })
        root.addView(footer)
        loading = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setBackgroundColor(0xff0c0c12.toInt()); setPadding(dp(32), dp(24), dp(32), dp(24))
        }
        spinner = ProgressBar(this); loading.addView(spinner, LinearLayout.LayoutParams(dp(36), dp(36)))
        loadingText = TextView(this).apply {
            textSize = 16f; setTextColor(muted); gravity = Gravity.CENTER; setPadding(0, dp(20), 0, dp(12))
        }
        loading.addView(loadingText)
        retry = button("Try again", "Retry session") { openExample(selected) }; loading.addView(retry)
        setContentView(root)
        showPicker()
        intent.getStringExtra("example")?.let { id ->
            openExample(if (id == "shell") null else examples.firstOrNull { it.id == id } ?: return@let)
        }
    }
    private fun assetImage(path: String) = ImageView(this).apply {
        if (path.endsWith(".svg")) {
            setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            val svg = SVG.getFromAsset(assets, path)
            val box = svg.documentViewBox
            setImageDrawable(android.graphics.drawable.PictureDrawable(
                if (box == null) svg.renderToPicture() else svg.renderToPicture(box.width().toInt(), box.height().toInt())))
        } else assets.open(path).use { setImageBitmap(android.graphics.BitmapFactory.decodeStream(it)) }
        scaleType = ImageView.ScaleType.FIT_CENTER
    }
    private fun button(label: String, description: String, action: () -> Unit) = Button(this).apply {
        text = label; contentDescription = description; isAllCaps = false
        minWidth = dp(44); minimumWidth = dp(44); setPadding(dp(4), 0, dp(4), 0)
        setTextColor(muted); setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { action() }
    }
    fun showPicker() {
        browser?.onPause()
        keys.visibility = View.GONE
        body.removeAllViews()
        val scroll = ScrollView(this)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(16)) }
        list.addView(TextView(this).apply { text = "What will you build?"; textSize = 28f; setTextColor(Color.WHITE) })
        list.addView(TextView(this).apply { text = "Start with an example. Run it locally on your device."; textSize = 14f; setTextColor(muted); setPadding(0, dp(8), 0, dp(16)) })
        if (session != null) list.addView(button("Resume terminal", "Resume terminal") { showTerminal() })
        list.addView(button("Open full shell", "Open full shell") { openExample(null) })
        examples.groupBy { it.group }.forEach { (group, items) ->
            list.addView(TextView(this).apply { text = group; textSize = 15f; setTextColor(muted); setPadding(0, dp(20), 0, dp(8)) })
            items.chunked(2).forEach { row ->
                val grid = LinearLayout(this)
                row.forEach { item ->
                    val card = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(14), dp(14), dp(14))
                        background = android.graphics.drawable.GradientDrawable().apply {
                            setColor(0xff14141e.toInt()); cornerRadius = dp(12).toFloat(); setStroke(dp(1), 0xff252532.toInt())
                        }
                        contentDescription = "Open ${item.title}"; isClickable = true; isFocusable = true
                        setOnClickListener { openExample(item) }
                    }
                    card.addView(assetImage("example-icons/${item.icon}"), LinearLayout.LayoutParams(dp(28), dp(28)).apply { bottomMargin = dp(10) })
                    card.addView(TextView(this).apply { text = item.title; textSize = 17f; setTextColor(Color.WHITE) })
                    card.addView(TextView(this).apply { text = item.description; textSize = 12f; setTextColor(muted); setPadding(0, dp(8), 0, 0) })
                    grid.addView(card, LinearLayout.LayoutParams(0, dp(160), 1f).apply { setMargins(0, 0, dp(8), dp(8)) })
                }
                list.addView(grid)
            }
        }
        scroll.addView(list); body.addView(scroll)
    }
    fun showTerminal() {
        browser?.onPause(); body.removeAllViews()
        keys.visibility = View.VISIBLE
        (terminal.parent as? ViewGroup)?.removeView(terminal)
        body.addView(terminal)
        body.addView(loading, FrameLayout.LayoutParams(-1, -1))
        updateLoading()
    }
    private fun updateLoading() {
        val failure = session?.failure
        loading.visibility = if (session?.isStarting == true || failure != null) View.VISIBLE else View.GONE
        loadingText.text = status.text
        spinner.visibility = if (failure == null) View.VISIBLE else View.GONE
        retry.visibility = if (failure == null) View.GONE else View.VISIBLE
    }
    fun openExample(example: ShellExample?) {
        // Serialize changes: cancellation cannot leave an old guest running behind a new session.
        transition?.cancel()
        transition = scope.launch {
          transitionLock.withLock {
            withContext(NonCancellable) { session?.close() }
            ensureActive()
            browser?.destroy(); browser = null
            terminal.close(); terminal = TerminalView(this@MainActivity)
            selected = example
            val next = ShellSession(this@MainActivity, example, terminal, {
                status.text = it; updateLoading()
            }, { updateLoading() })
            session = next
            terminal.onInput = next::send; terminal.onResize = next::resize
            showTerminal(); next.start()
          }
        }
    }
    private fun promptPreview() {
        val input = EditText(this).apply { setText(if (selected?.group == "Node.js") "3000" else "8000"); inputType = android.text.InputType.TYPE_CLASS_NUMBER }
        AlertDialog.Builder(this).setTitle("Open local server").setMessage("Port of the server running in your shell")
            .setView(input).setPositiveButton("Open") { _, _ ->
                val port = input.text.toString().toIntOrNull()
                if (port != null && port in 1..65535) openPreview(port)
            }.setNegativeButton("Cancel", null).show()
    }
    fun openPreview(port: Int) {
        val owner = session ?: return
        scope.launch {
            try {
                status.text = "Waiting for localhost:$port…"
                owner.waitForPort(port)
                if (session !== owner) return@launch
                browser?.destroy()
                val origin = "http://127.0.0.1:$port"
                val web = WebView(this@MainActivity).apply {
                    settings.javaScriptEnabled = true
                    settings.allowFileAccess = false; settings.allowContentAccess = false
                    settings.setSupportMultipleWindows(false)
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val url = request.url
                            return url.scheme != "http" || url.host != "127.0.0.1" || url.port != port
                        }
                    }
                }
                browser = web
                val panel = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                val nav = LinearLayout(this@MainActivity)
                val address = EditText(this@MainActivity).apply { setText("/"); isSingleLine = true }
                nav.addView(button("Terminal", "Back to terminal") { showTerminal() })
                nav.addView(address, LinearLayout.LayoutParams(0, dp(48), 1f))
                nav.addView(button("Go", "Navigate preview") {
                    val path = address.text.toString()
                    if (path.startsWith("/") && !path.startsWith("//")) web.loadUrl(origin + path)
                })
                nav.addView(button("↻", "Reload preview") { web.reload() })
                panel.addView(nav); panel.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
                keys.visibility = View.GONE
                body.removeAllViews(); body.addView(panel)
                web.loadUrl("$origin/"); status.text = "localhost:$port"
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { status.text = error.message ?: "Server unavailable" }
        }
    }
    override fun onDestroy() {
        transition?.cancel()
        val old = session; session = null
        scope.launch {
            withContext(NonCancellable) {
                transitionLock.withLock { old?.close(); terminal.close() }
            }
            scope.cancel()
        }
        browser?.destroy(); browser = null
        super.onDestroy()
    }
}
