plugins {
    kotlin("jvm") version "2.1.20" apply false
    kotlin("android") version "2.1.20" apply false
    id("com.android.library") version "8.9.2" apply false
    id("com.android.application") version "8.9.2" apply false
}
allprojects {
    group = "io.wasmer"
    version = "0.1.0-SNAPSHOT"
}
