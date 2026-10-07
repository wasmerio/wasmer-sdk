pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "wasmer-sdk-kotlin"
include(":sdk", ":examples")
// JVM development does not require an Android SDK installation.
if (providers.gradleProperty("android").orNull != "false") {
    include(":android", ":shell")
}
