plugins {
    id("com.android.application")
    kotlin("android")
}
val requestedAbis = providers.gradleProperty("wasmer.abis").orElse("arm64-v8a").get().split(",")
android {
    namespace = "io.wasmer.shell"
    compileSdk = 35
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "io.wasmer.shell"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += requestedAbis }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets.getByName("main") {
        jniLibs.srcDir("build/generated/jniLibs")
        assets.srcDir("build/generated/assets")
        assets.srcDir("build/generated/examples")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
val syncExamples by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("generated/examples"))
    from("../../wasmer-sh/examples.json")
    from("../../wasmer-sh/public") {
        include("wasmer-logo.svg", "example-icons/**")
    }
    from("../../wasmer-sh/workspace") {
        into("workspace")
        exclude("**/node_modules/**", "**/.next/**", "**/__pycache__/**", "**/.DS_Store")
    }
}
tasks.named("preBuild") {
    dependsOn(syncExamples)
    doLast {
        requestedAbis.forEach { abi ->
            check(file("build/generated/jniLibs/$abi/libwasmer_terminal.so").isFile) {
                "Build native libraries first: python3 kotlin/scripts/build.py --android --shell --abi $abi"
            }
        }
    }
}
dependencies {
    implementation(project(":android"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    implementation("com.caverock:androidsvg-aar:1.4")
    implementation("androidx.core:core-ktx:1.15.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.20")
}
