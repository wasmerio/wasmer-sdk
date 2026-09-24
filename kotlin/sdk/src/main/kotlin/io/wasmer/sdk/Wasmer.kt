package io.wasmer.sdk

import io.wasmer.sdk.ffi.*
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

typealias WasmerException = SdkException
typealias NetworkPolicy = NetworkMode
typealias ExitReason = ProcessExitReason
typealias Input = InputMode
typealias OutputMode = io.wasmer.sdk.ffi.OutputMode
typealias FileKind = io.wasmer.sdk.ffi.FileKind
typealias FileStat = io.wasmer.sdk.ffi.FileStat
typealias DirectoryEntry = io.wasmer.sdk.ffi.DirectoryEntry
typealias PackageLoadProgress = io.wasmer.sdk.ffi.PackageLoadProgress
typealias PackageLoadPhase = io.wasmer.sdk.ffi.PackageLoadPhase

/** Explicitly close sandboxes before their client. Cancellation alone does not kill a guest. */
class Wasmer(
    cacheDirectory: File = File(System.getProperty("user.home"), ".cache/wasmer-sdk"),
    outputBytes: Long? = null,
) {
    internal val core = WasmerCore(ClientOptions(cacheDirectory.absolutePath, outputBytes?.unsigned("outputBytes")))
    val packages = Packages(core)
    val sandboxes = Sandboxes(core)
    val capabilities = Capabilities(nodeApi = core.supportsNodeApi())
    suspend fun close() = core.shutdown()

    companion object
}

data class Capabilities(
    val localPackages: Boolean = true,
    val terminal: Boolean = true,
    val hostNetworking: Boolean = true,
    val portDiscovery: Boolean = false,
    val nativeWorkspace: Boolean = false,
    val nodeApi: Boolean = false,
)

sealed interface PackageSource {
    data class Registry(val specifier: String) : PackageSource
    data class Path(val file: File) : PackageSource
    data class Bytes(val bytes: ByteArray) : PackageSource
    data class Loaded(val value: Package) : PackageSource
}

data class PackageCommandDefinition(val module: String)
data class PackageDefinition(
    val modules: Map<String, ByteArray>,
    val commands: Map<String, PackageCommandDefinition>,
    val entrypoint: String? = null,
    val files: Map<String, ByteArray> = emptyMap(),
)

class Packages internal constructor(private val core: WasmerCore) {
    suspend fun create(definition: PackageDefinition): Package = Package(core.createPackage(
        io.wasmer.sdk.ffi.PackageDefinition(definition.modules,
            definition.commands.mapValues { io.wasmer.sdk.ffi.PackageCommandDefinition(it.value.module) },
            definition.entrypoint, definition.files),
    ))
    suspend fun load(specifier: String): Package = load(PackageSource.Registry(specifier))
    suspend fun load(bytes: ByteArray): Package = load(PackageSource.Bytes(bytes))
    suspend fun load(file: File): Package = load(PackageSource.Path(file))
    suspend fun load(source: PackageSource): Package = when (source) {
        is PackageSource.Registry -> Package(core.loadPackageRegistry(source.specifier))
        is PackageSource.Path -> Package(core.loadPackagePath(source.file.absolutePath))
        is PackageSource.Bytes -> Package(core.loadPackageBytes(source.bytes))
        is PackageSource.Loaded -> source.value
    }

    /** Progress callbacks run on native worker threads; dispatch to Main for UI updates. */
    suspend fun loadMany(
        sources: List<PackageSource>,
        onProgress: ((PackageLoadProgress) -> Unit)? = null,
    ): List<Package> {
        val cancellation = PackageLoadCancellation()
        val observer = onProgress?.let { callback -> object : PackageLoadObserver {
            override fun onProgress(progress: PackageLoadProgress) = callback(progress)
        } }
        try {
            return core.loadPackages(sources.map { it.toCore() }, observer, cancellation).map(::Package)
        } finally {
            cancellation.cancel()
            cancellation.destroy()
        }
    }
}

private fun PackageSource.toCore(): PackageLoadSource = when (this) {
    is PackageSource.Registry -> PackageLoadSource.Registry(specifier)
    is PackageSource.Path -> PackageLoadSource.Path(file.absolutePath)
    is PackageSource.Bytes -> PackageLoadSource.Bytes(bytes)
    is PackageSource.Loaded -> PackageLoadSource.Package(value.core)
}

class Package internal constructor(internal val core: PackageCore) {
    val id: String get() = core.id()
    val commands: List<String> get() = core.commands()
    val entrypoint: String? get() = core.entrypoint()
    fun command(name: String): CommandRef = CommandRef(core.command(name))
}
class CommandRef internal constructor(internal val core: CommandRefCore) {
    val name: String get() = core.name()
}

class Sandboxes internal constructor(private val core: WasmerCore) {
    suspend fun create(
        packages: List<PackageSource> = emptyList(),
        files: Map<String, ByteArray> = emptyMap(),
        env: Map<String, String> = emptyMap(),
        network: NetworkPolicy = NetworkPolicy.DISABLED,
    ): Sandbox {
        val resolved = Packages(core).loadMany(packages)
        return Sandbox(core.createSandbox(resolved.map { it.core }, files, env, network))
    }
}

class Sandbox internal constructor(private val core: SandboxCore) {
    val fs = SandboxFileSystem(core.filesystem())
    val ports = Ports(core.ports())
    fun command(name: String, args: List<String> = emptyList(), cwd: String? = null,
                env: Map<String, String> = emptyMap()): Command =
        Command(core.commandName(name, args, cwd, env))
    fun command(pkg: Package, args: List<String> = emptyList(), cwd: String? = null,
                env: Map<String, String> = emptyMap()): Command =
        Command(core.commandPackage(pkg.core, args, cwd, env))
    fun command(ref: CommandRef, args: List<String> = emptyList(), cwd: String? = null,
                env: Map<String, String> = emptyMap()): Command =
        Command(core.commandRef(ref.core, args, cwd, env))
    suspend fun installPackage(source: PackageSource): Package = Package(when (source) {
        is PackageSource.Registry -> core.installPackageRegistry(source.specifier)
        is PackageSource.Path -> core.installPackagePath(source.file.absolutePath)
        is PackageSource.Bytes -> core.installPackageBytes(source.bytes)
        is PackageSource.Loaded -> core.installPackageRef(source.value.core)
    })
    suspend fun installPackage(specifier: String): Package = installPackage(PackageSource.Registry(specifier))
    suspend fun installPackage(bytes: ByteArray): Package = installPackage(PackageSource.Bytes(bytes))
    suspend fun close() = core.shutdown()
}

data class TerminalOptions(val columns: Int = 80, val rows: Int = 24) {
    init { require(columns in 1..65535 && rows in 1..65535) { "Terminal dimensions must be 1..65535" } }
}

class Command internal constructor(private val core: CommandCore) {
    suspend fun run(
        input: ByteArray? = null,
        timeout: Duration? = null,
        outputBytes: Long? = null,
        check: Boolean = true,
    ): Output = Output(core.run(RunOptions(input, timeout?.milliseconds(), outputBytes?.unsigned("outputBytes"))))
        .also { if (check) it.check() }

    /** Drain stdout and stderr concurrently. Terminal mode always pipes all three streams. */
    suspend fun spawn(
        stdin: Input = Input.CLOSED,
        stdout: OutputMode = OutputMode.PIPE,
        stderr: OutputMode = OutputMode.PIPE,
        timeout: Duration? = null,
        outputBytes: Long? = null,
        terminal: TerminalOptions? = null,
    ): Process {
        val options = SpawnOptions(timeout?.milliseconds(), outputBytes?.unsigned("outputBytes"), stdin, stdout, stderr)
        return Process(if (terminal == null) core.spawn(options)
            else core.spawnTerminal(options, terminal.columns.toUInt(), terminal.rows.toUInt()))
    }
}

class Output internal constructor(private val core: ProcessOutput) {
    val exitCode: Int get() = core.exitCode
    val reason: ExitReason get() = core.reason
    val stdout: ByteArray get() = core.stdout
    val stderr: ByteArray get() = core.stderr
    val stdoutTruncated: Boolean get() = core.stdoutTruncated
    val stderrTruncated: Boolean get() = core.stderrTruncated
    val ok: Boolean get() = exitCode == 0 && reason == ExitReason.EXITED
    fun check(): Output { if (!ok) throw ProcessExitException(this); return this }
    fun text(): String = check().stdout.decodeToString(throwOnInvalidSequence = true)
}
class ProcessExitException(val output: Output) : Exception("Process ${output.reason}: exit code ${output.exitCode}")

class Process internal constructor(private val core: ProcessCore) {
    val id: UInt get() = core.id()
    val stdin: ProcessInput? = if (core.hasStdin()) ProcessInput(core) else null
    val stdout: ProcessStream? = if (core.hasStdout()) ProcessStream { core.readStdout(it) } else null
    val stderr: ProcessStream? = if (core.hasStderr()) ProcessStream { core.readStderr(it) } else null
    suspend fun wait(check: Boolean = false): Output = Output(core.wait()).also { if (check) it.check() }
    suspend fun terminate(gracePeriod: Duration = 1.seconds) = core.terminate(gracePeriod.milliseconds())
    fun kill() = core.kill()
    fun resizeTerminal(columns: Int, rows: Int) {
        val size = TerminalOptions(columns, rows)
        core.resizeTerminal(size.columns.toUInt(), size.rows.toUInt())
    }
}
class ProcessInput internal constructor(private val core: ProcessCore) {
    suspend fun write(bytes: ByteArray) = core.writeStdin(bytes)
    suspend fun write(text: String) = write(text.encodeToByteArray())
    suspend fun close() = core.closeStdin()
}
class ProcessStream internal constructor(private val read: suspend (ULong) -> ByteArray?) {
    private val reading = AtomicBoolean(false)
    /** Byte chunks may split UTF-8 characters. There can be only one active reader. */
    fun chunks(maxBytes: Int = 64 * 1024): Flow<ByteArray> = flow {
        require(maxBytes > 0) { "maxBytes must be positive" }
        check(reading.compareAndSet(false, true)) { "Stream already has a reader" }
        try {
            while (true) emit(read(maxBytes.toULong()) ?: break)
        } finally { reading.set(false) }
    }
}
class SandboxFileSystem internal constructor(private val core: FileSystemCore) {
    suspend fun write(path: String, bytes: ByteArray) = core.write(path, bytes)
    suspend fun writeText(path: String, text: String) = write(path, text.encodeToByteArray())
    suspend fun read(path: String): ByteArray = core.read(path)
    suspend fun readText(path: String): String = read(path).decodeToString(throwOnInvalidSequence = true)
    suspend fun mkdir(path: String, recursive: Boolean = true) = core.mkdir(path, recursive)
    suspend fun readDir(path: String = "."): List<DirectoryEntry> = core.readDir(path)
    suspend fun stat(path: String): FileStat = core.stat(path)
    suspend fun remove(path: String, recursive: Boolean = false) = core.remove(path, recursive)
    suspend fun rename(from: String, to: String) = core.rename(from, to)
}
class Ports internal constructor(private val core: PortsCore) {
    suspend fun wait(port: Int, timeout: Duration = 30.seconds) {
        require(port in 1..65535) { "port must be 1..65535" }
        core.wait(port.toUShort(), timeout.milliseconds())
    }
}

/** Cleanup also runs when a coroutine is cancelled. */
suspend inline fun <T> Wasmer.use(block: (Wasmer) -> T): T = try { block(this) }
    finally { withContext(NonCancellable) { close() } }
suspend inline fun <T> Sandbox.use(block: (Sandbox) -> T): T = try { block(this) }
    finally { withContext(NonCancellable) { close() } }

private fun Long.unsigned(name: String): ULong {
    require(this >= 0) { "$name must not be negative" }
    return toULong()
}
private fun Duration.milliseconds(): ULong {
    require(isFinite() && !isNegative()) { "Duration must be finite and nonnegative" }
    require(this == Duration.ZERO || inWholeMilliseconds > 0) { "Duration must be at least one millisecond" }
    return inWholeMilliseconds.toULong()
}
