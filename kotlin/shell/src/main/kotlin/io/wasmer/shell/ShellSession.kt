package io.wasmer.shell

import android.content.Context
import io.wasmer.sdk.*
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.Duration.Companion.seconds

/** Application orchestration uses the public Kotlin SDK exclusively. */
class ShellSession(
    private val context: Context,
    private val example: ShellExample?,
    private val terminal: TerminalView,
    private val status: (String) -> Unit,
    private val ready: () -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val input = Channel<ByteArray>(64)
    private var client: Wasmer? = null
    private var sandbox: Sandbox? = null
    private var process: io.wasmer.sdk.Process? = null
    private var closed = false
    private val closeLock = Mutex()
    var isReady = false; private set
    var isStarting = true; private set
    var failure: Exception? = null; private set
    private var startup: Job? = null

    fun start() {
        startup = scope.launch {
            try {
                status("Initializing the SDK…")
                withContext(Dispatchers.IO) { client = Wasmer(File(context.cacheDir, "wasmer")) }
                val client = checkNotNull(client)
                val examples = example?.let(::listOf) ?: ShellExample.load(context)
                    .filter { client.capabilities.nodeApi || !it.needsNode }
                if (example?.needsNode == true && !client.capabilities.nodeApi) {
                    error("Node.js needs the ARM64 build with Node-API enabled")
                }
                val names = (listOf("wasmer/bash") + examples.flatMap { it.packages } +
                    if (example == null) listOf("syrusakbary/cowsay@=0.3.0") else emptyList()).distinct()
                val packages = client.packages.loadMany(names.map(PackageSource::Registry)) { progress ->
                    scope.launch {
                        if (!isReady) status("${progress.phase.name.lowercase().replaceFirstChar { it.uppercase() }} packages" +
                            (progress.download.percent?.let { " · ${it.toInt()}%" } ?: "…"))
                    }
                }
                status("Preparing your workspace…")
                val pythonPath = if (example == null) "/workspace/wasix-packages" else "/workspace/.python-packages"
                val sandbox = client.sandboxes.create(packages.map(PackageSource::Loaded), env = mapOf(
                    "HOME" to "/workspace", "TERM" to "xterm-256color",
                    "PATH" to "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.",
                    "npm_config_store_dir" to "/workspace/.pnpm-store", "npm_config_cache_dir" to "/workspace/.pnpm-cache",
                    "npm_config_network_concurrency" to "1",
                    "PIP_EXTRA_INDEX_URL" to "https://python-registry.wasmer.app/simple/",
                    "PIP_PLATFORM" to "wasix_wasm32", "PIP_ONLY_BINARY" to ":all:",
                    "PIP_TARGET" to pythonPath, "PYTHONPATH" to pythonPath,
                ) + (example?.env ?: emptyMap()), network = NetworkPolicy.HOST)
                this@ShellSession.sandbox = sandbox
                for (item in examples) seed("workspace/${item.source}", if (example == null) item.id else ".", sandbox)
                terminal.feed(("\u001b[1;38;5;141mWelcome to Wasmer Shell\u001b[0m\n" +
                    "Run WebAssembly locally on Android with Kotlin.\n\n" +
                    (example?.let { "${it.title}\n" + (it.install?.let { command -> "Install: $command\n" } ?: "") +
                        "Run: ${it.run}\n\n" } ?: "Bash, Python, Node.js, and tools in one workspace.\n\n")).encodeToByteArray())
                val process = sandbox.command(packages.first().command("bash"), listOf("--noprofile", "--norc", "-c",
                    "exec bash --noprofile --norc -i 2>&1"), env = mapOf(
                    "PS1" to "\\[\\033[1;38;5;141m\\]➜\\[\\033[0m\\] \\[\\033[1;38;5;117m\\]\\W\\[\\033[0m\\] \\[\\033[1m\\]$\\[\\033[0m\\] ",
                )).spawn(terminal = TerminalOptions(terminal.columns, terminal.rows))
                this@ShellSession.process = process
                isStarting = false; isReady = true; status(example?.title ?: "Full shell"); ready()
                coroutineScope {
                    val writer = launch { for (bytes in input) process.stdin!!.write(bytes) }
                    val stdout = launch { process.stdout!!.chunks().collect(terminal::feed) }
                    val stderr = launch { process.stderr!!.chunks().collect(terminal::feed) }
                    val result = process.wait()
                    writer.cancel(); stdout.join(); stderr.join()
                    isReady = false
                    status("Session ended · ${result.exitCode}")
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                isStarting = false; isReady = false
                failure = error
                status(error.message ?: error.toString())
            } finally {
                withContext(NonCancellable) { release() }
            }
        }
    }
    private suspend fun seed(asset: String, destination: String, sandbox: Sandbox) {
        val files = context.assets.list(asset).orEmpty()
        sandbox.fs.mkdir(destination)
        val existing = sandbox.fs.readDir(destination).map { it.name }.toSet()
        for (name in files) {
            val child = "$asset/$name"
            val target = "$destination/$name"
            if (!context.assets.list(child).isNullOrEmpty()) seed(child, target, sandbox)
            else if (name !in existing) sandbox.fs.write(target, context.assets.open(child).use { it.readBytes() })
        }
    }
    fun send(bytes: ByteArray) {
        if (!isReady) return
        if (!input.trySend(bytes).isSuccess) status("Input buffer is full; wait for the running command")
    }
    fun resize(columns: Int, rows: Int) { process?.resizeTerminal(columns, rows) }
    suspend fun waitForPort(port: Int) { checkNotNull(sandbox).ports.wait(port, 15.seconds) }
    suspend fun close() {
        withContext(NonCancellable) {
            closeLock.withLock {
                if (!closed) {
                    closed = true; isStarting = false; isReady = false; input.close()
                    process?.kill()
                    startup?.cancelAndJoin()
                    release()
                    scope.cancel()
                }
            }
        }
    }
    private suspend fun release() {
        process?.kill(); process = null
        try { sandbox?.close() } finally { sandbox = null; client?.close(); client = null }
    }
}
