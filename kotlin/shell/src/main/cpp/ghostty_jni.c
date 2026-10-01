#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "GhosttyBridge.h"

// Reuse the exact VT engine, key encoding, palette and cell extraction used by iOS.
#define JNI(name) Java_io_wasmer_shell_Ghostty_##name
static WTTerminal *terminal(jlong handle) { return (WTTerminal *)(uintptr_t)handle; }
static jbyteArray bytes(JNIEnv *env, const uint8_t *data, size_t length) {
    jbyteArray result = (*env)->NewByteArray(env, (jsize)length);
    if (result && length) (*env)->SetByteArrayRegion(env, result, 0, (jsize)length, (const jbyte *)data);
    return result;
}
JNIEXPORT jlong JNICALL JNI(create)(JNIEnv *env, jobject self, jint columns, jint rows) {
    (void)env; (void)self;
    if (columns < 1 || columns > 65535 || rows < 1 || rows > 65535) return 0;
    return (jlong)(uintptr_t)wt_new((uint16_t)columns, (uint16_t)rows);
}
JNIEXPORT void JNICALL JNI(destroy)(JNIEnv *env, jobject self, jlong handle) {
    (void)env; (void)self; wt_free(terminal(handle));
}
JNIEXPORT void JNICALL JNI(feed)(JNIEnv *env, jobject self, jlong handle, jbyteArray input) {
    (void)self;
    jsize length = (*env)->GetArrayLength(env, input);
    jbyte *data = (*env)->GetByteArrayElements(env, input, NULL);
    if (!data) return;
    wt_feed(terminal(handle), (const uint8_t *)data, (size_t)length);
    (*env)->ReleaseByteArrayElements(env, input, data, JNI_ABORT);
}
JNIEXPORT jboolean JNICALL JNI(resize)(JNIEnv *env, jobject self, jlong handle, jint columns, jint rows) {
    (void)env; (void)self;
    if (columns < 1 || columns > 65535 || rows < 1 || rows > 65535) return JNI_FALSE;
    return wt_resize(terminal(handle), (uint16_t)columns, (uint16_t)rows);
}
JNIEXPORT void JNICALL JNI(scroll)(JNIEnv *env, jobject self, jlong handle, jint delta) {
    (void)env; (void)self; wt_scroll(terminal(handle), delta);
}
JNIEXPORT void JNICALL JNI(bottom)(JNIEnv *env, jobject self, jlong handle) {
    (void)env; (void)self; wt_bottom(terminal(handle));
}
JNIEXPORT jbyteArray JNICALL JNI(key)(JNIEnv *env, jobject self, jlong handle, jint key) {
    (void)self;
    uint8_t buffer[128];
    size_t length = wt_key(terminal(handle), key, buffer, sizeof(buffer));
    return bytes(env, buffer, length);
}
JNIEXPORT jbyteArray JNICALL JNI(responses)(JNIEnv *env, jobject self, jlong handle) {
    (void)self;
    uint8_t buffer[65536];
    size_t length = wt_take_response(terminal(handle), buffer, sizeof(buffer));
    return bytes(env, buffer, length);
}
static void put32(uint8_t *out, uint32_t value) {
    for (int i = 0; i < 4; i++) out[i] = (uint8_t)(value >> (i * 8));
}
JNIEXPORT jbyteArray JNICALL JNI(frame)(JNIEnv *env, jobject self, jlong handle) {
    (void)self;
    WTFrame frame;
    if (!wt_begin_frame(terminal(handle), &frame)) return bytes(env, NULL, 0);
    size_t capacity = 65536, used = 24;
    uint8_t *buffer = malloc(capacity);
    if (!buffer) return NULL;
    put32(buffer, frame.column); put32(buffer + 4, frame.row);
    put32(buffer + 8, frame.visible); put32(buffer + 12, frame.foreground);
    put32(buffer + 16, frame.background);
    uint32_t count = 0;
    WTCell cell;
    while (wt_next_cell(terminal(handle), &cell)) {
        size_t required = used + 28 + cell.length;
        if (required > capacity) {
            while (capacity < required) capacity *= 2;
            uint8_t *grown = realloc(buffer, capacity);
            if (!grown) { free(buffer); return NULL; }
            buffer = grown;
        }
        put32(buffer + used, cell.column); put32(buffer + used + 4, cell.row);
        put32(buffer + used + 8, cell.foreground); put32(buffer + used + 12, cell.background);
        put32(buffer + used + 16, cell.width);
        put32(buffer + used + 20, cell.bold | (cell.italic << 1) | (cell.underline << 2) | (cell.strike << 3));
        put32(buffer + used + 24, (uint32_t)cell.length);
        if (cell.length) memcpy(buffer + used + 28, cell.text, cell.length);
        used = required; count++;
    }
    put32(buffer + 20, count);
    jbyteArray result = bytes(env, buffer, used);
    free(buffer);
    return result;
}
