package io.wasmer.examples

import io.wasmer.sdk.*
import java.io.File
import kotlinx.coroutines.*
import kotlin.time.Duration.Companion.seconds

/** ./gradlew -Pandroid=false :examples:run --args='python|stream|files|wasm path.wasm' */
fun main(args: Array<String>) = runBlocking {
    Wasmer().use { wasmer ->
        val name = args.firstOrNull() ?: "python"
        val pkg = if (name == "wasm") wasmer.packages.load(File(args.getOrElse(1) { error("Pass a .wasm file") }).readBytes())
            else wasmer.packages.load("python/python@=3.13.20")
        wasmer.sandboxes.create(listOf(PackageSource.Loaded(pkg))).use { sandbox ->
            when (name) {
                "python" -> print(sandbox.command("python", listOf("-c", "print('Hello from Kotlin!')")).run(timeout = 30.seconds).text())
                "files" -> {
                    sandbox.fs.writeText("message.txt", "A shared Kotlin/Wasm workspace")
                    print(sandbox.command("python", listOf("-c", "print(open('/workspace/message.txt').read())")).run().text())
                }
                "stream" -> {
                    val process = sandbox.command("python", listOf("-u", "-c", "print(input())"))
                        .spawn(stdin = Input.PIPE, timeout = 30.seconds)
                    coroutineScope {
                        val out = launch { process.stdout!!.chunks().collect { System.out.write(it) } }
                        val err = launch { process.stderr!!.chunks().collect { System.err.write(it) } }
                        process.stdin!!.write("Hello through stdin\n")
                        process.stdin!!.close()
                        process.wait(check = true)
                        out.join(); err.join()
                    }
                }
                "wasm" -> print(sandbox.command(pkg, args.drop(2)).run(timeout = 30.seconds).text())
                else -> error("Choose python, stream, files, or wasm")
            }
        }
    }
}
