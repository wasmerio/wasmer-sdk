package io.wasmer.sdk

import java.io.File
import java.nio.file.Files

class JvmSdkTest : SdkContract() {
    override fun fixture(name: String): ByteArray =
        checkNotNull(javaClass.getResourceAsStream("/Fixtures/$name")).use { it.readBytes() }
    override fun cacheDirectory(): File = Files.createTempDirectory("wasmer-kotlin-test-").toFile()
}
