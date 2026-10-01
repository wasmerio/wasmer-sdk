plugins {
    kotlin("jvm")
    `java-library`
    `maven-publish`
}
kotlin { jvmToolchain(17) }
dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.1")
    implementation("net.java.dev.jna:jna:5.17.0")
    testImplementation(kotlin("test-junit"))
}
sourceSets.test {
    kotlin.srcDir("src/contractTest/kotlin")
    resources.srcDir("../../swift/Tests/WasmerSDKTests")
}
tasks.test {
    systemProperty("jna.library.path", rootProject.file("../target/debug").absolutePath)
    testLogging { events("passed", "skipped", "failed") }
}
java { withSourcesJar() }
publishing { publications { create<MavenPublication>("sdk") {
    artifactId = "wasmer-sdk-jvm"
    from(components["java"])
} } }
