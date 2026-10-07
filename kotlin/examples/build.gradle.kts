plugins { kotlin("jvm"); application }
kotlin { jvmToolchain(17) }
dependencies { implementation(project(":sdk")) }
application {
    mainClass = "io.wasmer.examples.MainKt"
    applicationDefaultJvmArgs = listOf("-Djna.library.path=${rootProject.file("../target/debug")}")
}
