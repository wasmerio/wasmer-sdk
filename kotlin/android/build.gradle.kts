plugins {
    id("com.android.library")
    kotlin("android")
    `maven-publish`
}
val requestedAbis = providers.gradleProperty("wasmer.abis").orElse("arm64-v8a").get().split(",")
android {
    namespace = "io.wasmer.sdk"
    compileSdk = 35
    ndkVersion = "28.2.13676358"
    defaultConfig {
        minSdk = 28
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
        ndk { abiFilters += requestedAbis }
    }
    // AGP's library ABI filters don't filter prebuilt jniLibs from an AAR.
    packaging.jniLibs.excludes += listOf("arm64-v8a", "x86_64")
        .filter { it !in requestedAbis }.map { "**/$it/**" }
    sourceSets {
        getByName("main") {
            java.srcDir("../sdk/src/main/kotlin")
            java.srcDir("vendor/rustls-platform-verifier")
            jniLibs.srcDir("build/generated/jniLibs")
            assets.srcDir("build/generated/assets")
        }
        getByName("androidTest") {
            java.srcDir("../sdk/src/contractTest/kotlin")
            assets.srcDir("../../swift/Tests/WasmerSDKTests")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    publishing { singleVariant("release") { withSourcesJar() } }
}
val syncVerifierLicenses by tasks.registering(Sync::class) {
    from("vendor/rustls-platform-verifier") { include("LICENSE-*") }
    into(layout.buildDirectory.dir("generated/assets/rustls-platform-verifier"))
}
tasks.named("preBuild") { dependsOn(syncVerifierLicenses); doLast {
    requestedAbis.forEach { abi ->
        check(file("build/generated/jniLibs/$abi/libwasmer_sdk_uniffi.so").isFile) {
            "Missing $abi native SDK; run python3 kotlin/scripts/build.py --android --abi $abi"
        }
    }
} }
dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.1")
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation("androidx.startup:startup-runtime:1.2.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.20")
}
afterEvaluate { publishing { publications { create<MavenPublication>("release") {
    artifactId = "wasmer-sdk-android"
    from(components["release"])
} } } }
