package io.wasmer.sdk

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID

class AndroidSdkTest : SdkContract() {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    override fun fixture(name: String): ByteArray =
        instrumentation.context.assets.open("Fixtures/$name").use { it.readBytes() }
    override fun cacheDirectory(): File =
        File(instrumentation.targetContext.cacheDir, "sdk-test-${UUID.randomUUID()}")
}
