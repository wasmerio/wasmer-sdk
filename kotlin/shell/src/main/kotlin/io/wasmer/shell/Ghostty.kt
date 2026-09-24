package io.wasmer.shell

/** Confined to the UI thread, like the iOS terminal view. */
internal object Ghostty {
    init { System.loadLibrary("wasmer_terminal") }
    external fun create(columns: Int, rows: Int): Long
    external fun destroy(handle: Long)
    external fun feed(handle: Long, bytes: ByteArray)
    external fun resize(handle: Long, columns: Int, rows: Int): Boolean
    external fun scroll(handle: Long, delta: Int)
    external fun bottom(handle: Long)
    external fun key(handle: Long, key: Int): ByteArray
    external fun responses(handle: Long): ByteArray
    external fun frame(handle: Long): ByteArray
}
