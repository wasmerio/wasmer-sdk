use jni::{EnvUnowned, objects::JObject};

/// Called with an application Context by the Android library's initializer.
/// JNI owns the arguments for this call; EnvUnowned catches panics before they
/// can unwind across the ABI and translates failures into Java exceptions.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_wasmer_sdk_AndroidRuntime_initialize<'local>(
    mut env: EnvUnowned<'local>,
    _receiver: JObject<'local>,
    context: JObject<'local>,
) {
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}
