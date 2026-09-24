package io.wasmer.sdk

import android.content.Context
import androidx.startup.Initializer
import java.io.File

/** Uses the app's writable cache. Certificate verification is initialized by Android Startup. */
fun Wasmer.Companion.create(context: Context, outputBytes: Long? = null): Wasmer {
    AndroidRuntime.initialize(context.applicationContext)
    return Wasmer(File(context.cacheDir, "wasmer"), outputBytes)
}

internal object AndroidRuntime {
    init { System.loadLibrary("wasmer_sdk_uniffi") }
    external fun initialize(context: Context)
}

class WasmerInitializer : Initializer<Unit> {
    override fun create(context: Context) = AndroidRuntime.initialize(context.applicationContext)
    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
