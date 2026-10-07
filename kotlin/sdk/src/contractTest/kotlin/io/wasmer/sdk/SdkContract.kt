package io.wasmer.sdk

import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.*
import kotlin.test.*
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/** The same real Kotlin -> UniFFI -> Rust -> Wasm contract runs on JVM and Android. */
abstract class SdkContract {
    abstract fun fixture(name: String): ByteArray
    abstract fun cacheDirectory(): File

    private fun contract(block: suspend (Wasmer, Sandbox, Package) -> Unit) = runBlocking {
        withTimeout(60.seconds) {
            val cache = cacheDirectory()
            try {
                Wasmer(cache).use { client ->
                    val pkg = client.packages.create(PackageDefinition(
                        modules = listOf("hello", "echo", "fail").associateWith { fixture("$it.wasm") },
                        commands = listOf("hello", "echo", "fail").associateWith { PackageCommandDefinition(it) },
                        entrypoint = "hello",
                    ))
                    client.sandboxes.create(listOf(PackageSource.Loaded(pkg))).use { sandbox ->
                        block(client, sandbox, pkg)
                    }
                }
            } finally { cache.deleteRecursively() }
        }
    }

    @Test fun packageDefinitionsAndSelectors() = contract { client, sandbox, pkg ->
        assertEquals(setOf("hello", "echo", "fail"), pkg.commands.toSet())
        assertEquals("hello", pkg.entrypoint)
        for (command in listOf(sandbox.command("hello"), sandbox.command(pkg), sandbox.command(pkg.command("hello")))) {
            val result = command.run(timeout = 10.seconds)
            assertEquals("Hello from Swift!\n", result.text()) // Shared Swift fixture.
            assertEquals(ExitReason.EXITED, result.reason)
            assertTrue(result.stderr.isEmpty())
        }
        val raw = client.packages.load(fixture("hello.wasm"))
        assertEquals(listOf("main"), raw.commands)
        sandbox.installPackage(PackageSource.Loaded(raw))
        assertEquals("Hello from Swift!\n", sandbox.command("main").run().text())
        assertFailsWith<WasmerException> { client.packages.load(byteArrayOf(0, 1, 2)) }
    }

    @Test fun capturedOutputExitAndTruncation() = contract { _, sandbox, _ ->
        val failure = assertFailsWith<ProcessExitException> { sandbox.command("fail").run() }
        assertEquals(7, failure.output.exitCode)
        assertFalse(failure.output.ok)
        assertEquals(7, sandbox.command("fail").run(check = false).exitCode)
        val limited = sandbox.command("hello").run(outputBytes = 5)
        assertEquals(5, limited.stdout.size)
        assertTrue(limited.stdoutTruncated)
        val input = "Kotlin 🦀\n".encodeToByteArray()
        assertContentEquals(input, sandbox.command("echo").run(input = input).stdout)
    }

    @Test fun liveStdinStreamsAndEof() = contract { _, sandbox, _ ->
        val process = sandbox.command("echo").spawn(stdin = Input.PIPE, timeout = 10.seconds)
        coroutineScope {
            val stdout = async { process.stdout!!.bytes() }
            val stderr = async { process.stderr!!.bytes() }
            val input = ByteArray(160_000) { (it % 251).toByte() }
            process.stdin!!.write(input)
            process.stdin!!.close()
            assertTrue(process.wait(check = true).ok)
            assertContentEquals(input, stdout.await())
            assertTrue(stderr.await().isEmpty())
        }
    }

    @Test fun workspaceFilesAndErrors() = contract { _, sandbox, _ ->
        val fs = sandbox.fs
        fs.writeText("nested/a", "Kotlin 🦀")
        fs.rename("nested/a", "nested/b")
        assertEquals("Kotlin 🦀", fs.readText("nested/b"))
        assertEquals(FileKind.FILE, fs.stat("nested/b").kind)
        assertEquals(listOf("b"), fs.readDir("nested").map { it.name })
        fs.write("binary", byteArrayOf(0, -1, -128))
        assertContentEquals(byteArrayOf(0, -1, -128), fs.read("binary"))
        assertFails { fs.readText("binary") }
        assertFailsWith<WasmerException> { fs.writeText("../escape", "no") }
        fs.remove("nested", recursive = true)
        assertFailsWith<WasmerException> { fs.read("nested/b") }
    }

    @Test fun timeoutTerminationAndClosedSandbox() = contract { _, sandbox, _ ->
        val timed = sandbox.command("echo").spawn(stdin = Input.PIPE,
            stdout = OutputMode.DISCARD, stderr = OutputMode.DISCARD, timeout = 50.milliseconds)
        assertEquals(ExitReason.TIMEOUT, timed.wait().reason)
        val process = sandbox.command("echo").spawn(stdin = Input.PIPE,
            stdout = OutputMode.DISCARD, stderr = OutputMode.DISCARD)
        process.terminate(10.milliseconds)
        assertEquals(ExitReason.TERMINATED, process.wait().reason)
        sandbox.close()
        assertFailsWith<WasmerException> { sandbox.command("hello").run() }
    }

    @Test fun terminalResizeAndPipeOwnership() = contract { _, sandbox, _ ->
        val terminal = sandbox.command("echo").spawn(terminal = TerminalOptions(80, 24), timeout = 10.seconds)
        assertNotNull(terminal.stdin)
        assertNotNull(terminal.stdout)
        assertNotNull(terminal.stderr)
        terminal.resizeTerminal(100, 30)
        assertFailsWith<IllegalArgumentException> { terminal.resizeTerminal(0, 24) }
        coroutineScope {
            val output = async { terminal.stdout!!.bytes().decodeToString() }
            val errors = async { terminal.stderr!!.bytes() }
            terminal.stdin!!.write("hello\n")
            terminal.stdin!!.close()
            terminal.wait(check = true)
            assertTrue(output.await().contains("hello"))
            errors.await()
        }
        val ordinary = sandbox.command("echo").spawn(stdin = Input.PIPE)
        try { assertFailsWith<WasmerException> { ordinary.resizeTerminal(80, 24) } }
        finally { ordinary.kill(); ordinary.wait() }
    }

    @Test fun bundledFilesAndProgress() = contract { client, sandbox, _ ->
        val pkg = client.packages.create(PackageDefinition(
            modules = mapOf("app" to fixture("package-files.wasm")),
            commands = mapOf("files" to PackageCommandDefinition("app")),
            files = mapOf("/data/input.txt" to "original".encodeToByteArray()),
        ))
        sandbox.installPackage(PackageSource.Loaded(pkg))
        assertEquals("original", sandbox.command(pkg).run().text())
        val loaded = client.packages.loadMany(listOf(PackageSource.Loaded(pkg)))
        assertEquals(pkg.id, loaded.single().id)
    }

    @Test fun invalidArguments() = contract { _, sandbox, _ ->
        assertFailsWith<IllegalArgumentException> { sandbox.command("hello").run(timeout = (-1).seconds) }
        assertFailsWith<IllegalArgumentException> { sandbox.command("hello").run(outputBytes = -1) }
        assertFailsWith<IllegalArgumentException> { sandbox.ports.wait(0) }
    }
}

private suspend fun ProcessStream.bytes(): ByteArray {
    val output = ByteArrayOutputStream()
    chunks().collect { output.write(it) }
    return output.toByteArray()
}
