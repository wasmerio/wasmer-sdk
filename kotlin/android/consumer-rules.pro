# UniFFI/JNA discovers native symbols and structures by reflection.
-keep class io.wasmer.sdk.ffi.** { *; }
-keep class com.sun.jna.** { *; }
-keep class org.rustls.platformverifier.** { *; }
-keep class io.wasmer.sdk.AndroidRuntime { *; }
-dontwarn java.awt.**
