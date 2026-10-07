package io.wasmer.shell

import android.content.Context
import org.json.JSONArray

data class ShellExample(
    val id: String, val source: String, val title: String, val group: String,
    val description: String, val packages: List<String>, val install: String?, val run: String,
    val env: Map<String, String>,
    val icon: String,
) {
    val needsNode get() = packages.any { it.startsWith("wasmer/edge@") }
    companion object {
        fun load(context: Context): List<ShellExample> {
            val catalog = JSONArray(context.assets.open("examples.json").bufferedReader().use { it.readText() })
            return (0 until catalog.length()).mapNotNull { index ->
                val item = catalog.getJSONObject(index)
                // The native shell currently owns one foreground command tree.
                // Hide templates that require an automatically managed server.
                if (!item.isNull("server")) return@mapNotNull null
                val packages = item.getJSONArray("packages")
                val env = item.optJSONObject("env")
                ShellExample(item.getString("id"), item.getString("source"), item.getString("title"),
                    item.getString("group"), item.getString("description"),
                    (0 until packages.length()).map(packages::getString),
                    if (item.isNull("install")) null else item.getString("install"), item.getString("run"),
                    env?.keys()?.asSequence()?.associateWith { env.getString(it) } ?: emptyMap(), item.getString("icon"))
            }
        }
    }
}
