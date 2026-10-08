// The guest half of wasmer-webgpu.
//
// Most of webgpu.h needs no guest-side state and is forwarded straight to the
// host (wgpu_forwarders.gen.c). This file is the rest: the parts of the API
// that are about the *caller's* address space and control flow.
//
//  - Callbacks. The host never calls into the guest. An asynchronous call
//    registers its callback here under a future id; the host later reports
//    "future N finished with ..." as a record, and this file invokes the
//    callback, at the points webgpu.h allows for its callback mode.
//  - Mapped ranges. wgpuBufferGetMappedRange hands out pointers, which have
//    to be guest memory. They are heap blocks here, filled from and flushed
//    to the real mapping through the copying calls the host implements.
//  - Results the caller frees (adapter info strings, feature lists, surface
//    capabilities): allocated here, so the matching FreeMembers is free().
//
// Thread safety: every table is behind one mutex, and no callback is ever
// invoked while it is held.

#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "wgpu_imports.gen.h"

// Host ABI revision this shim was written against (major << 16 | minor).
#define WGPU_SHIM_ABI_MAJOR 0u

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

static void lock(void) { pthread_mutex_lock(&g_lock); }
static void unlock(void) { pthread_mutex_unlock(&g_lock); }

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

typedef struct DeviceRecord {
    uint32_t device;  // handle; 0 while the device request is in flight
    uint64_t lost_future;
    WGPUUncapturedErrorCallback on_error;
    void* error_userdata1;
    void* error_userdata2;
} DeviceRecord;

typedef struct Event {
    uint64_t id;
    uint32_t kind;      // WGPU_EVENT_*
    uint32_t mode;      // WGPUCallbackMode
    uint32_t instance;  // the instance whose ProcessEvents/WaitAny delivers it
    bool ready;
    void (*callback)(void);
    void* userdata1;
    void* userdata2;
    // The result, once ready.
    uint32_t status;
    uint32_t handle;
    uint32_t aux;
    char* message;
    uint32_t message_length;
    uint8_t* extra;
    uint32_t extra_length;
    // wgpuAdapterRequestDevice: what to install when the device arrives.
    DeviceRecord* device_record;
} Event;

// Tracked events, sorted by id (ids only grow, so new ones are appended).
static Event** g_events;
static size_t g_event_count;
static size_t g_event_capacity;
static uint64_t g_next_future = 1;

static DeviceRecord** g_devices;
static size_t g_device_count;
static size_t g_device_capacity;

static void* grow(void* items, size_t* capacity, size_t item_size) {
    size_t wanted = *capacity ? *capacity * 2 : 8;
    void* grown = realloc(items, wanted * item_size);
    if (!grown) abort();
    *capacity = wanted;
    return grown;
}

// Index of the event with this id, or -1. Caller holds the lock.
static long find_event(uint64_t id) {
    size_t lo = 0, hi = g_event_count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (g_events[mid]->id < id) lo = mid + 1; else hi = mid;
    }
    return (lo < g_event_count && g_events[lo]->id == id) ? (long)lo : -1;
}

static Event* take_event_at(size_t index) {
    Event* event = g_events[index];
    memmove(&g_events[index], &g_events[index + 1], (g_event_count - index - 1) * sizeof(Event*));
    g_event_count--;
    return event;
}

static void free_event(Event* event) {
    free(event->message);
    free(event->extra);
    free(event->device_record);
    free(event);
}

static DeviceRecord* find_device(uint32_t device) {
    for (size_t i = 0; i < g_device_count; i++) {
        if (g_devices[i]->device == device) return g_devices[i];
    }
    return NULL;
}

static uint32_t cancelled_status(uint32_t kind) {
    switch (kind) {
        case WGPU_EVENT_REQUEST_ADAPTER: return WGPURequestAdapterStatus_CallbackCancelled;
        case WGPU_EVENT_REQUEST_DEVICE: return WGPURequestDeviceStatus_CallbackCancelled;
        case WGPU_EVENT_BUFFER_MAP: return WGPUMapAsyncStatus_CallbackCancelled;
        case WGPU_EVENT_POP_ERROR_SCOPE: return WGPUPopErrorScopeStatus_CallbackCancelled;
        case WGPU_EVENT_CREATE_COMPUTE_PIPELINE:
        case WGPU_EVENT_CREATE_RENDER_PIPELINE: return WGPUCreatePipelineAsyncStatus_CallbackCancelled;
        case WGPU_EVENT_QUEUE_WORK_DONE: return WGPUQueueWorkDoneStatus_CallbackCancelled;
        case WGPU_EVENT_COMPILATION_INFO: return WGPUCompilationInfoRequestStatus_CallbackCancelled;
        case WGPU_EVENT_DEVICE_LOST: return WGPUDeviceLostReason_CallbackCancelled;
        default: return 0;
    }
}

static uint32_t rd32(const uint8_t* p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint64_t rd64(const uint8_t* p) { uint64_t v; memcpy(&v, p, 8); return v; }

// Invokes the user's callback for a finished event and frees the event.
// Never called with the lock held: the callback may call back into the API.
static void complete(Event* event) {
    WGPUStringView message = { event->message, event->message_length };
    if (event->message_length == 0) message.data = NULL;
    void* u1 = event->userdata1;
    void* u2 = event->userdata2;

    if (event->callback) {
        switch (event->kind) {
            case WGPU_EVENT_REQUEST_ADAPTER:
                ((WGPURequestAdapterCallback)event->callback)(
                    (WGPURequestAdapterStatus)event->status, (WGPUAdapter)(uintptr_t)event->handle, message, u1, u2);
                break;
            case WGPU_EVENT_REQUEST_DEVICE:
                ((WGPURequestDeviceCallback)event->callback)(
                    (WGPURequestDeviceStatus)event->status, (WGPUDevice)(uintptr_t)event->handle, message, u1, u2);
                break;
            case WGPU_EVENT_BUFFER_MAP:
                ((WGPUBufferMapCallback)event->callback)((WGPUMapAsyncStatus)event->status, message, u1, u2);
                break;
            case WGPU_EVENT_POP_ERROR_SCOPE:
                ((WGPUPopErrorScopeCallback)event->callback)(
                    (WGPUPopErrorScopeStatus)event->status, (WGPUErrorType)event->aux, message, u1, u2);
                break;
            case WGPU_EVENT_CREATE_COMPUTE_PIPELINE:
                ((WGPUCreateComputePipelineAsyncCallback)event->callback)(
                    (WGPUCreatePipelineAsyncStatus)event->status, (WGPUComputePipeline)(uintptr_t)event->handle,
                    message, u1, u2);
                break;
            case WGPU_EVENT_CREATE_RENDER_PIPELINE:
                ((WGPUCreateRenderPipelineAsyncCallback)event->callback)(
                    (WGPUCreatePipelineAsyncStatus)event->status, (WGPURenderPipeline)(uintptr_t)event->handle,
                    message, u1, u2);
                break;
            case WGPU_EVENT_QUEUE_WORK_DONE:
                ((WGPUQueueWorkDoneCallback)event->callback)((WGPUQueueWorkDoneStatus)event->status, message, u1, u2);
                break;
            case WGPU_EVENT_DEVICE_LOST: {
                WGPUDevice device = (WGPUDevice)(uintptr_t)event->handle;
                ((WGPUDeviceLostCallback)event->callback)(
                    &device, (WGPUDeviceLostReason)event->status, message, u1, u2);
                break;
            }
            case WGPU_EVENT_COMPILATION_INFO: {
                // extra: u32 count; u32 reserved; then per message
                //   u32 type; u32 length; u64 lineNum, linePos, offset, length; bytes (padded to 8)
                WGPUCompilationInfo info = { NULL, 0, NULL };
                WGPUCompilationMessage* messages = NULL;
                if (event->extra_length >= 8) {
                    uint32_t count = rd32(event->extra);
                    const uint8_t* at = event->extra + 8;
                    const uint8_t* end = event->extra + event->extra_length;
                    messages = calloc(count ? count : 1, sizeof(WGPUCompilationMessage));
                    if (!messages) abort();
                    uint32_t parsed = 0;
                    while (parsed < count && at + 40 <= end) {
                        uint32_t length = rd32(at + 4);
                        if (at + 40 + length > end) break;
                        WGPUCompilationMessage* m = &messages[parsed++];
                        m->nextInChain = NULL;
                        m->type = (WGPUCompilationMessageType)rd32(at);
                        m->lineNum = rd64(at + 8);
                        m->linePos = rd64(at + 16);
                        m->offset = rd64(at + 24);
                        m->length = rd64(at + 32);
                        m->message.data = (const char*)(at + 40);
                        m->message.length = length;
                        at += 40 + ((length + 7u) & ~7u);
                    }
                    info.messageCount = parsed;
                    info.messages = messages;
                }
                ((WGPUCompilationInfoCallback)event->callback)(
                    (WGPUCompilationInfoRequestStatus)event->status, &info, u1, u2);
                free(messages);
                break;
            }
            default:
                break;
        }
    }
    free_event(event);
}

// An uncaptured error has no future: it goes to the device's callback at once.
static void deliver_uncaptured_error(uint32_t device_handle, uint32_t type, const char* text, uint32_t length) {
    lock();
    DeviceRecord* record = find_device(device_handle);
    WGPUUncapturedErrorCallback callback = record ? record->on_error : NULL;
    void* u1 = record ? record->error_userdata1 : NULL;
    void* u2 = record ? record->error_userdata2 : NULL;
    unlock();
    if (!callback) {
        // What a native implementation does when nobody is listening.
        fprintf(stderr, "WebGPU uncaptured error (type %u): %.*s\n", type, (int)length, text);
        return;
    }
    WGPUDevice device = (WGPUDevice)(uintptr_t)device_handle;
    WGPUStringView message = { text, length };
    callback(&device, (WGPUErrorType)type, message, u1, u2);
}

#define RECORD_HEADER 32u

// Drops the object an event produced when there is no callback left to
// hand it to.
static void discard_result(uint32_t kind, uint32_t handle) {
    if (!handle) return;
    switch (kind) {
        case WGPU_EVENT_REQUEST_ADAPTER:
            __wgpu_import_wgpuAdapterRelease((WGPUAdapter)(uintptr_t)handle);
            break;
        case WGPU_EVENT_REQUEST_DEVICE:
            wasmer_wgpu_device_release((WGPUDevice)(uintptr_t)handle);
            break;
        case WGPU_EVENT_CREATE_COMPUTE_PIPELINE:
            __wgpu_import_wgpuComputePipelineRelease((WGPUComputePipeline)(uintptr_t)handle);
            break;
        case WGPU_EVENT_CREATE_RENDER_PIPELINE:
            __wgpu_import_wgpuRenderPipelineRelease((WGPURenderPipeline)(uintptr_t)handle);
            break;
        default:
            break;
    }
}

// Takes one host record. Returns an event to complete right away (one whose
// mode allows spontaneous delivery), or NULL.
static Event* absorb_record(const uint8_t* record) {
    uint64_t future = rd64(record);
    uint32_t kind = rd32(record + 8);
    uint32_t status = rd32(record + 12);
    uint32_t handle = rd32(record + 16);
    uint32_t aux = rd32(record + 20);
    uint32_t message_length = rd32(record + 24);
    uint32_t extra_length = rd32(record + 28);
    const char* text = (const char*)record + RECORD_HEADER;
    const uint8_t* extra = record + RECORD_HEADER + ((message_length + 7u) & ~7u);

    if (kind == WGPU_EVENT_UNCAPTURED_ERROR) {
        deliver_uncaptured_error(handle, aux, text, message_length);
        return NULL;
    }

    lock();
    long index = find_event(future);
    if (index < 0) {
        // Cancelled in the meantime (its instance was dropped). Do not leak
        // an object nobody will ever receive.
        unlock();
        discard_result(kind, handle);
        return NULL;
    }
    Event* event = g_events[index];
    event->ready = true;
    event->status = status;
    event->handle = handle;
    event->aux = aux;
    if (message_length) {
        event->message = malloc(message_length);
        if (!event->message) abort();
        memcpy(event->message, text, message_length);
        event->message_length = message_length;
    }
    if (extra_length) {
        event->extra = malloc(extra_length);
        if (!event->extra) abort();
        memcpy(event->extra, extra, extra_length);
        event->extra_length = extra_length;
    }
    if (kind == WGPU_EVENT_REQUEST_DEVICE && event->device_record) {
        if (status == WGPURequestDeviceStatus_Success && handle) {
            // The device exists now: its error callback goes live.
            event->device_record->device = handle;
            if (g_device_count == g_device_capacity)
                g_devices = grow(g_devices, &g_device_capacity, sizeof(DeviceRecord*));
            g_devices[g_device_count++] = event->device_record;
            event->device_record = NULL;
        }
    }
    Event* now = NULL;
    if (event->mode == WGPUCallbackMode_AllowSpontaneous) now = take_event_at((size_t)index);
    unlock();
    return now;
}

// Feeds every record in [buffer, buffer + length) to absorb_record.
static void absorb_records(const uint8_t* buffer, uint32_t length) {
    uint32_t at = 0;
    while (at + RECORD_HEADER <= length) {
        const uint8_t* record = buffer + at;
        uint32_t size = RECORD_HEADER + ((rd32(record + 24) + 7u) & ~7u) + ((rd32(record + 28) + 7u) & ~7u);
        if (at + size > length) break;
        Event* now = absorb_record(record);
        if (now) complete(now);
        at += size;
    }
}

// Collects every event the host has ready, without blocking.
static void pump(void) {
    uint8_t stack[1024];
    uint8_t* buffer = stack;
    uint32_t capacity = sizeof stack;
    for (;;) {
        int32_t written = wasmer_wgpu_poll(buffer, capacity);
        if (written < 0) {
            // The next record is larger than the buffer.
            uint32_t needed = (uint32_t)(-written);
            if (buffer != stack) free(buffer);
            buffer = malloc(needed);
            if (!buffer) abort();
            capacity = needed;
            continue;
        }
        if (written == 0) break;
        absorb_records(buffer, (uint32_t)written);
    }
    if (buffer != stack) free(buffer);
}

// Refuses to run against a host whose ABI revision this shim does not speak.
// The import module name catches a different major revision at instantiation;
// this catches a host that reports one anyway.
static void check_host_abi(void) {
    static bool checked;
    if (checked) return;
    uint32_t version = wasmer_wgpu_abi_version();
    if ((version >> 16) != WGPU_SHIM_ABI_MAJOR) {
        fprintf(stderr, "libwebgpu: the host speaks WebGPU ABI %u.%u, this program was built for %u.x\n",
                version >> 16, version & 0xFFFFu, WGPU_SHIM_ABI_MAJOR);
        abort();
    }
    checked = true;
}

// Whether `instance` is a live instance handle.
static bool instance_alive(uint32_t instance) {
    return instance != 0 && wasmer_wgpu_object_instance(instance) == instance;
}

// Registers a callback under a new future id. `source` is the object the
// operation was started on; the event belongs to the instance it descends
// from. Returns 0 for a callback mode webgpu.h does not define.
static uint64_t track(uint32_t kind, uint32_t mode, void (*callback)(void), void* userdata1, void* userdata2,
                      uint32_t source, DeviceRecord* device_record) {
    if (mode == 0 && callback == NULL) {
        // A zero-initialized callback info: nothing to call, any time will do.
        mode = WGPUCallbackMode_AllowSpontaneous;
    }
    if (mode < WGPUCallbackMode_WaitAnyOnly || mode > WGPUCallbackMode_AllowSpontaneous) {
        free(device_record);
        return 0;
    }
    check_host_abi();
    uint32_t instance = wasmer_wgpu_object_instance(source);
    Event* event = calloc(1, sizeof(Event));
    if (!event) abort();
    event->kind = kind;
    event->mode = mode;
    event->instance = instance;
    event->callback = callback;
    event->userdata1 = userdata1;
    event->userdata2 = userdata2;
    event->device_record = device_record;

    lock();
    event->id = g_next_future++;
    if (g_event_count == g_event_capacity) g_events = grow(g_events, &g_event_capacity, sizeof(Event*));
    g_events[g_event_count++] = event;
    uint64_t id = event->id;
    unlock();
    return id;
}

// Completes a just-tracked event as cancelled if its instance is already
// gone: nothing would ever deliver it otherwise. Returns true if it did.
static bool cancel_if_orphaned(uint64_t id) {
    lock();
    long index = find_event(id);
    if (index < 0) { unlock(); return true; }
    Event* event = g_events[index];
    uint32_t instance = event->instance;
    bool spontaneous = event->mode == WGPUCallbackMode_AllowSpontaneous;
    unlock();
    if (spontaneous || instance_alive(instance)) return false;

    lock();
    index = find_event(id);
    event = index < 0 ? NULL : take_event_at((size_t)index);
    unlock();
    if (!event) return true;
    event->status = cancelled_status(event->kind);
    event->handle = 0;
    complete(event);
    return true;
}

#define CALLBACK(fn) ((void (*)(void))(fn))

// ---------------------------------------------------------------------------
// Instance: events and waiting
// ---------------------------------------------------------------------------

// Takes the lowest-numbered ready event of `instance` that ProcessEvents may
// deliver. Caller frees through complete().
static Event* take_processable(uint32_t instance) {
    lock();
    Event* found = NULL;
    for (size_t i = 0; i < g_event_count; i++) {
        Event* event = g_events[i];
        if (event->ready && event->instance == instance && event->mode == WGPUCallbackMode_AllowProcessEvents) {
            found = take_event_at(i);
            break;
        }
    }
    unlock();
    return found;
}

// Whether `instance` still waits for something that polling can bring. A
// live device counts (its device-lost event is tracked for as long as it
// lives): besides being lost, it can report an uncaptured error at any time,
// and that has no future of its own to be waited for.
static bool has_outstanding(uint32_t instance) {
    lock();
    bool outstanding = false;
    for (size_t i = 0; i < g_event_count && !outstanding; i++) {
        Event* event = g_events[i];
        outstanding = !event->ready && event->instance == instance;
    }
    unlock();
    return outstanding;
}

void wgpuInstanceProcessEvents(WGPUInstance instance) {
    uint32_t handle = (uint32_t)(uintptr_t)instance;
    pump();
    bool delivered = false;
    for (Event* event; (event = take_processable(handle));) {
        complete(event);
        delivered = true;
    }
    if (delivered || !has_outstanding(handle)) return;
    // Work is outstanding and none of it was ready. A program that spins on
    // ProcessEvents waiting for a result must still make progress on hosts
    // where results only arrive once the guest yields (a browser event loop).
    wasmer_wgpu_yield();
    pump();
    for (Event* event; (event = take_processable(handle));) complete(event);
}

// Monotonic nanoseconds, for wait deadlines.
static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

// Fills `pending` with the listed futures that are tracked and not ready.
// Returns how many; `*any_done` says whether a listed future is finished
// (ready, or no longer tracked because it already completed).
static size_t pending_futures(size_t count, const WGPUFutureWaitInfo* futures, uint64_t* pending, bool* any_done) {
    size_t n = 0;
    *any_done = false;
    lock();
    for (size_t i = 0; i < count; i++) {
        long index = find_event(futures[i].future.id);
        if (index < 0 || g_events[index]->ready) *any_done = true;
        else pending[n++] = futures[i].future.id;
    }
    unlock();
    return n;
}

WGPUWaitStatus wgpuInstanceWaitAny(WGPUInstance instance, size_t futureCount, WGPUFutureWaitInfo* futures,
                                   uint64_t timeoutNS) {
    (void)instance;
    if (futureCount == 0) return WGPUWaitStatus_Success;
    if (!futures) return WGPUWaitStatus_Error;

    uint64_t* pending = malloc(futureCount * sizeof(uint64_t));
    if (!pending) abort();
    uint8_t stack[1024];
    uint8_t* buffer = stack;
    uint32_t capacity = sizeof stack;
    uint64_t start = timeoutNS ? now_ns() : 0;
    WGPUWaitStatus failure = (WGPUWaitStatus)0;
    // Whether the host had a chance to deliver something during this call.
    bool blocked = false;

    for (;;) {
        // The epoch is read before looking: an event queued after this point
        // makes the wait below return, even if another thread collects it.
        uint64_t epoch = wasmer_wgpu_epoch();
        pump();
        bool any_done;
        size_t pending_count = pending_futures(futureCount, futures, pending, &any_done);
        if (any_done || pending_count == 0 || timeoutNS == 0) {
            // A program that polls (a zero timeout, or a list that keeps
            // naming a future that completed long ago) must still make
            // progress on hosts where results only arrive once the guest
            // yields (a browser's event loop), as with ProcessEvents. So
            // while anything listed is pending, no call returns without the
            // host having had one chance to deliver.
            if (pending_count > 0 && !blocked) {
                blocked = true;
                wasmer_wgpu_yield();
                continue;
            }
            break;
        }
        if (pending_count > 64) {  // timedWaitAnyMaxCount
            failure = WGPUWaitStatus_Error;
            break;
        }
        uint64_t remaining = UINT64_MAX;
        if (timeoutNS != UINT64_MAX) {
            uint64_t elapsed = now_ns() - start;
            if (elapsed >= timeoutNS) break;
            remaining = timeoutNS - elapsed;
        }
        int32_t written = wasmer_wgpu_wait(pending, (uint32_t)pending_count, remaining, epoch, buffer, capacity);
        blocked = true;
        if (written == INT32_MIN) {  // this host cannot block
            failure = WGPUWaitStatus_Error;
            break;
        }
        if (written < 0) {
            // The next record does not fit; nothing was consumed.
            uint32_t needed = (uint32_t)(-written);
            if (buffer != stack) free(buffer);
            buffer = malloc(needed);
            if (!buffer) abort();
            capacity = needed;
            continue;
        }
        absorb_records(buffer, (uint32_t)written);
    }
    if (buffer != stack) free(buffer);
    free(pending);
    if (failure) return failure;

    // Deliver, in id order, every listed future that is ready, whatever its
    // mode: being waited on is permission to call back.
    for (;;) {
        Event* next = NULL;
        lock();
        size_t best = (size_t)-1;
        for (size_t i = 0; i < futureCount; i++) {
            long index = find_event(futures[i].future.id);
            if (index >= 0 && g_events[index]->ready && (size_t)index < best) best = (size_t)index;
        }
        if (best != (size_t)-1) next = take_event_at(best);
        unlock();
        if (!next) break;
        complete(next);
    }
    bool completed_any = false;
    lock();
    for (size_t i = 0; i < futureCount; i++) {
        bool done = find_event(futures[i].future.id) < 0;
        futures[i].completed = done;
        completed_any |= done;
    }
    unlock();
    return completed_any ? WGPUWaitStatus_Success : WGPUWaitStatus_TimedOut;
}

void wgpuInstanceRelease(WGPUInstance instance) {
    uint32_t handle = (uint32_t)(uintptr_t)instance;
    if (!wasmer_wgpu_instance_release(instance)) return;
    // The last reference is gone: nothing can deliver this instance's events
    // any more, and every callback is still owed exactly one call.
    for (;;) {
        Event* event = NULL;
        lock();
        for (size_t i = 0; i < g_event_count; i++) {
            if (g_events[i]->instance == handle) {
                event = take_event_at(i);
                break;
            }
        }
        unlock();
        if (!event) break;
        if (!event->ready) {
            event->status = cancelled_status(event->kind);
            event->handle = 0;
        }
        complete(event);
    }
}

WGPUFuture wgpuInstanceRequestAdapter(WGPUInstance instance, WGPURequestAdapterOptions const* options,
                                      WGPURequestAdapterCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_REQUEST_ADAPTER, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)instance, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_instance_request_adapter(instance, options, id);
        pump();
    }
    return (WGPUFuture){ id };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

WGPUFuture wgpuAdapterRequestDevice(WGPUAdapter adapter, WGPUDeviceDescriptor const* descriptor,
                                    WGPURequestDeviceCallbackInfo callbackInfo) {
    uint32_t source = (uint32_t)(uintptr_t)adapter;
    DeviceRecord* record = calloc(1, sizeof(DeviceRecord));
    if (!record) abort();
    WGPUDeviceLostCallbackInfo lost = { 0 };
    if (descriptor) {
        lost = descriptor->deviceLostCallbackInfo;
        record->on_error = descriptor->uncapturedErrorCallbackInfo.callback;
        record->error_userdata1 = descriptor->uncapturedErrorCallbackInfo.userdata1;
        record->error_userdata2 = descriptor->uncapturedErrorCallbackInfo.userdata2;
    }
    // The device-lost future exists from the moment the device is requested.
    uint64_t lost_id =
        track(WGPU_EVENT_DEVICE_LOST, lost.mode, CALLBACK(lost.callback), lost.userdata1, lost.userdata2, source, NULL);
    record->lost_future = lost_id;

    uint64_t id = track(WGPU_EVENT_REQUEST_DEVICE, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, source, record);
    if (!id) {
        // The request was rejected outright, so there is no device to lose.
        lock();
        long index = find_event(lost_id);
        Event* orphan = index < 0 ? NULL : take_event_at((size_t)index);
        unlock();
        if (orphan) free_event(orphan);
        return (WGPUFuture){ 0 };
    }
    if (!cancel_if_orphaned(id)) {
        wasmer_wgpu_adapter_request_device(adapter, descriptor, id, lost_id);
        pump();
    }
    return (WGPUFuture){ id };
}

// Fetches a serialized result from the host into a malloc'd block. `*length`
// receives its size. Returns NULL (and *length < 0) if the host refused.
#define FETCH(call_with_buf_cap, length_out, block_out)                 \
    do {                                                                \
        uint8_t probe[256];                                             \
        uint8_t* buf = probe;                                           \
        uint32_t cap = sizeof probe;                                    \
        int32_t n = (call_with_buf_cap);                                \
        (block_out) = NULL;                                             \
        (length_out) = n;                                               \
        if (n >= 0) {                                                   \
            (block_out) = malloc((size_t)n ? (size_t)n : 1);            \
            if (!(block_out)) abort();                                  \
            if ((uint32_t)n <= cap) {                                   \
                memcpy((block_out), probe, (size_t)n);                  \
            } else {                                                    \
                buf = (block_out);                                      \
                cap = (uint32_t)n;                                      \
                (length_out) = (call_with_buf_cap);                     \
            }                                                           \
        }                                                               \
    } while (0)

// Turns a serialized adapter info (see encode_info in the host) into a
// WGPUAdapterInfo whose four strings live in one heap block.
static WGPUStatus fill_adapter_info(uint8_t* blob, int32_t length, WGPUAdapterInfo* info) {
    if (!blob || length < 40) {
        free(blob);
        return WGPUStatus_Error;
    }
    uint32_t vendor = rd32(blob + 24), architecture = rd32(blob + 28);
    uint32_t device = rd32(blob + 32), description = rd32(blob + 36);
    if ((uint64_t)40 + vendor + architecture + device + description > (uint64_t)length) {
        free(blob);
        return WGPUStatus_Error;
    }
    char* strings = malloc((size_t)vendor + architecture + device + description + 1);
    if (!strings) abort();
    memcpy(strings, blob + 40, (size_t)vendor + architecture + device + description);
    info->backendType = (WGPUBackendType)rd32(blob);
    info->adapterType = (WGPUAdapterType)rd32(blob + 4);
    info->vendorID = rd32(blob + 8);
    info->deviceID = rd32(blob + 12);
    info->subgroupMinSize = rd32(blob + 16);
    info->subgroupMaxSize = rd32(blob + 20);
    // vendor.data is the block: wgpuAdapterInfoFreeMembers frees it.
    info->vendor = (WGPUStringView){ strings, vendor };
    info->architecture = (WGPUStringView){ strings + vendor, architecture };
    info->device = (WGPUStringView){ strings + vendor + architecture, device };
    info->description = (WGPUStringView){ strings + vendor + architecture + device, description };
    free(blob);
    return WGPUStatus_Success;
}

WGPUStatus wgpuAdapterGetInfo(WGPUAdapter adapter, WGPUAdapterInfo* info) {
    if (!info) return WGPUStatus_Error;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_adapter_get_info(adapter, buf, cap), length, blob);
    return fill_adapter_info(blob, length, info);
}

void wgpuAdapterInfoFreeMembers(WGPUAdapterInfo adapterInfo) { free((void*)adapterInfo.vendor.data); }

// A serialized u32 list becomes { count, heap array }.
static void fill_u32_list(uint8_t* blob, int32_t length, size_t* count, const void** items) {
    if (!blob || length < 0) {
        free(blob);
        *count = 0;
        *items = NULL;
        return;
    }
    *count = (size_t)length / 4;
    *items = blob;  // already the right bytes: a little-endian u32 array
    if (*count == 0) {
        free(blob);
        *items = NULL;
    }
}

void wgpuAdapterGetFeatures(WGPUAdapter adapter, WGPUSupportedFeatures* features) {
    if (!features) return;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_adapter_get_features(adapter, buf, cap), length, blob);
    fill_u32_list(blob, length, &features->featureCount, (const void**)&features->features);
}

void wgpuSupportedFeaturesFreeMembers(WGPUSupportedFeatures supportedFeatures) {
    free((void*)supportedFeatures.features);
}

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

void wgpuGetInstanceFeatures(WGPUSupportedInstanceFeatures* features) {
    if (!features) return;
    static const WGPUInstanceFeatureName kAll[] = {
        WGPUInstanceFeatureName_TimedWaitAny,
        WGPUInstanceFeatureName_ShaderSourceSPIRV,
        WGPUInstanceFeatureName_MultipleDevicesPerAdapter,
    };
    size_t total = sizeof kAll / sizeof kAll[0];
    WGPUInstanceFeatureName* list = malloc(total * sizeof *list);
    if (!list) abort();
    size_t count = 0;
    for (size_t i = 0; i < total; i++) {
        if (__wgpu_import_wgpuHasInstanceFeature(kAll[i])) list[count++] = kAll[i];
    }
    if (count == 0) {
        free(list);
        list = NULL;
    }
    features->featureCount = count;
    features->features = list;
}

void wgpuSupportedInstanceFeaturesFreeMembers(WGPUSupportedInstanceFeatures supportedInstanceFeatures) {
    free((void*)supportedInstanceFeatures.features);
}

void wgpuInstanceGetWGSLLanguageFeatures(WGPUInstance instance, WGPUSupportedWGSLLanguageFeatures* features) {
    if (!features) return;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_instance_get_wgsl_language_features(instance, buf, cap), length, blob);
    fill_u32_list(blob, length, &features->featureCount, (const void**)&features->features);
}

void wgpuSupportedWGSLLanguageFeaturesFreeMembers(WGPUSupportedWGSLLanguageFeatures supportedWGSLLanguageFeatures) {
    free((void*)supportedWGSLLanguageFeatures.features);
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

WGPUStatus wgpuDeviceGetAdapterInfo(WGPUDevice device, WGPUAdapterInfo* adapterInfo) {
    if (!adapterInfo) return WGPUStatus_Error;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_device_get_adapter_info(device, buf, cap), length, blob);
    return fill_adapter_info(blob, length, adapterInfo);
}

void wgpuDeviceGetFeatures(WGPUDevice device, WGPUSupportedFeatures* features) {
    if (!features) return;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_device_get_features(device, buf, cap), length, blob);
    fill_u32_list(blob, length, &features->featureCount, (const void**)&features->features);
}

WGPUFuture wgpuDeviceGetLostFuture(WGPUDevice device) {
    lock();
    DeviceRecord* record = find_device((uint32_t)(uintptr_t)device);
    uint64_t id = record ? record->lost_future : 0;
    unlock();
    return (WGPUFuture){ id };
}

void wgpuDeviceRelease(WGPUDevice device) {
    uint32_t handle = (uint32_t)(uintptr_t)device;
    if (!wasmer_wgpu_device_release(device)) return;
    // Dropping the last reference destroys the device. Its error callback is
    // done; the lost callback fires (with a null device) from the pump.
    lock();
    for (size_t i = 0; i < g_device_count; i++) {
        if (g_devices[i]->device == handle) {
            free(g_devices[i]);
            g_devices[i] = g_devices[--g_device_count];
            break;
        }
    }
    unlock();
    pump();
}

WGPUFuture wgpuDevicePopErrorScope(WGPUDevice device, WGPUPopErrorScopeCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_POP_ERROR_SCOPE, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)device, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_device_pop_error_scope(device, id);
        pump();
    }
    return (WGPUFuture){ id };
}

WGPUFuture wgpuDeviceCreateComputePipelineAsync(WGPUDevice device, WGPUComputePipelineDescriptor const* descriptor,
                                                WGPUCreateComputePipelineAsyncCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_CREATE_COMPUTE_PIPELINE, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)device, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_device_create_compute_pipeline_async(device, descriptor, id);
        pump();
    }
    return (WGPUFuture){ id };
}

WGPUFuture wgpuDeviceCreateRenderPipelineAsync(WGPUDevice device, WGPURenderPipelineDescriptor const* descriptor,
                                               WGPUCreateRenderPipelineAsyncCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_CREATE_RENDER_PIPELINE, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)device, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_device_create_render_pipeline_async(device, descriptor, id);
        pump();
    }
    return (WGPUFuture){ id };
}

// ---------------------------------------------------------------------------
// Queue, shader module
// ---------------------------------------------------------------------------

WGPUFuture wgpuQueueOnSubmittedWorkDone(WGPUQueue queue, WGPUQueueWorkDoneCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_QUEUE_WORK_DONE, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)queue, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_queue_on_submitted_work_done(queue, id);
        pump();
    }
    return (WGPUFuture){ id };
}

WGPUFuture wgpuShaderModuleGetCompilationInfo(WGPUShaderModule shaderModule,
                                              WGPUCompilationInfoCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_COMPILATION_INFO, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)shaderModule, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_shader_module_get_compilation_info(shaderModule, id);
        pump();
    }
    return (WGPUFuture){ id };
}

// ---------------------------------------------------------------------------
// Buffer mapping
// ---------------------------------------------------------------------------

// One pointer handed out by wgpuBufferGet(Const)MappedRange.
typedef struct Shadow {
    void* block;  // what malloc returned
    void* data;   // what the caller got
    size_t offset;
    size_t size;
    bool writable;
} Shadow;

typedef struct MappedBuffer {
    uint32_t buffer;
    Shadow* shadows;
    size_t count;
    size_t capacity;
} MappedBuffer;

static MappedBuffer* g_mapped;
static size_t g_mapped_count;
static size_t g_mapped_capacity;

static MappedBuffer* find_mapped(uint32_t buffer) {
    for (size_t i = 0; i < g_mapped_count; i++) {
        if (g_mapped[i].buffer == buffer) return &g_mapped[i];
    }
    return NULL;
}

// Detaches a buffer's shadows from the table. Caller frees them.
static MappedBuffer take_mapped(uint32_t buffer) {
    MappedBuffer taken = { 0 };
    lock();
    MappedBuffer* entry = find_mapped(buffer);
    if (entry) {
        taken = *entry;
        *entry = g_mapped[--g_mapped_count];
    }
    unlock();
    return taken;
}

static void free_mapped(MappedBuffer* mapped) {
    for (size_t i = 0; i < mapped->count; i++) free(mapped->shadows[i].block);
    free(mapped->shadows);
}

typedef struct MapInfo {
    uint64_t offset;
    uint64_t size;
    uint32_t mode;
    uint32_t state;
} MapInfo;

static void* get_mapped_range(WGPUBuffer buffer, size_t offset, size_t size, bool writable) {
    uint32_t handle = (uint32_t)(uintptr_t)buffer;
    MapInfo info;
    if (!wasmer_wgpu_buffer_map_info(buffer, &info) || info.state != WGPUBufferMapState_Mapped) return NULL;
    // A pointer the caller may write through needs a mapping that takes writes.
    if (writable && !(info.mode & WGPUMapMode_Write)) return NULL;
    uint64_t map_end = info.offset + info.size;
    if (offset < info.offset || offset > map_end) return NULL;
    if (size == WGPU_WHOLE_MAP_SIZE) size = (size_t)(map_end - offset);
    if ((uint64_t)offset + size > map_end) return NULL;
    // The rules of the JavaScript getMappedRange, which webgpu.h inherits.
    if (offset % 8 != 0 || size % 4 != 0) return NULL;

    lock();
    MappedBuffer* mapped = find_mapped(handle);
    if (mapped) {
        for (size_t i = 0; i < mapped->count; i++) {
            Shadow* other = &mapped->shadows[i];
            if (offset < other->offset + other->size && other->offset < offset + size) {
                unlock();
                return NULL;  // ranges of one mapping may not overlap
            }
        }
    }
    unlock();

    // The pointer is congruent to the buffer offset modulo 16, so data laid
    // out for the buffer is equally aligned in memory.
    void* block = aligned_alloc(16, ((size + 16) + 15) & ~(size_t)15);
    if (!block) return NULL;
    void* data = (char*)block + (offset & 15);
    // Start from the buffer's contents, so that a partial write through a
    // writable range does not clobber what the caller did not touch.
    if (size && __wgpu_import_wgpuBufferReadMappedRange(buffer, offset, data, size) != WGPUStatus_Success) {
        free(block);
        return NULL;
    }

    lock();
    mapped = find_mapped(handle);
    if (!mapped) {
        if (g_mapped_count == g_mapped_capacity) g_mapped = grow(g_mapped, &g_mapped_capacity, sizeof(MappedBuffer));
        mapped = &g_mapped[g_mapped_count++];
        *mapped = (MappedBuffer){ .buffer = handle };
    }
    if (mapped->count == mapped->capacity) mapped->shadows = grow(mapped->shadows, &mapped->capacity, sizeof(Shadow));
    mapped->shadows[mapped->count++] = (Shadow){ block, data, offset, size, writable };
    unlock();
    return data;
}

void* wgpuBufferGetMappedRange(WGPUBuffer buffer, size_t offset, size_t size) {
    return get_mapped_range(buffer, offset, size, true);
}

void const* wgpuBufferGetConstMappedRange(WGPUBuffer buffer, size_t offset, size_t size) {
    return get_mapped_range(buffer, offset, size, false);
}

void wgpuBufferUnmap(WGPUBuffer buffer) {
    MappedBuffer mapped = take_mapped((uint32_t)(uintptr_t)buffer);
    // Everything written through a writable pointer reaches the buffer now.
    for (size_t i = 0; i < mapped.count; i++) {
        Shadow* shadow = &mapped.shadows[i];
        if (shadow->writable && shadow->size)
            __wgpu_import_wgpuBufferWriteMappedRange(buffer, shadow->offset, shadow->data, shadow->size);
    }
    free_mapped(&mapped);
    __wgpu_import_wgpuBufferUnmap(buffer);
    pump();  // a map that was still pending is aborted by this
}

void wgpuBufferDestroy(WGPUBuffer buffer) {
    MappedBuffer mapped = take_mapped((uint32_t)(uintptr_t)buffer);
    free_mapped(&mapped);
    __wgpu_import_wgpuBufferDestroy(buffer);
    pump();
}

void wgpuBufferRelease(WGPUBuffer buffer) {
    if (!wasmer_wgpu_buffer_release(buffer)) return;
    MappedBuffer mapped = take_mapped((uint32_t)(uintptr_t)buffer);
    free_mapped(&mapped);
}

WGPUFuture wgpuBufferMapAsync(WGPUBuffer buffer, WGPUMapMode mode, size_t offset, size_t size,
                              WGPUBufferMapCallbackInfo callbackInfo) {
    uint64_t id = track(WGPU_EVENT_BUFFER_MAP, callbackInfo.mode, CALLBACK(callbackInfo.callback),
                        callbackInfo.userdata1, callbackInfo.userdata2, (uint32_t)(uintptr_t)buffer, NULL);
    if (id && !cancel_if_orphaned(id)) {
        wasmer_wgpu_buffer_map_async(buffer, mode, offset, size, id);
        pump();
    }
    return (WGPUFuture){ id };
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

WGPUStatus wgpuSurfaceGetCapabilities(WGPUSurface surface, WGPUAdapter adapter, WGPUSurfaceCapabilities* capabilities) {
    if (!capabilities) return WGPUStatus_Error;
    uint8_t* blob;
    int32_t length;
    FETCH(wasmer_wgpu_surface_get_capabilities(surface, adapter, buf, cap), length, blob);
    if (!blob || length < 24) {
        free(blob);
        return WGPUStatus_Error;
    }
    // u64 usages; u32 formats, presentModes, alphaModes, reserved; then the arrays.
    uint32_t formats = rd32(blob + 8), present_modes = rd32(blob + 12), alpha_modes = rd32(blob + 16);
    if ((uint64_t)24 + 4ull * ((uint64_t)formats + present_modes + alpha_modes) > (uint64_t)length) {
        free(blob);
        return WGPUStatus_Error;
    }
    // One block for the three arrays; `formats` is the block FreeMembers frees.
    uint32_t* lists = malloc(4 * ((size_t)formats + present_modes + alpha_modes) + 4);
    if (!lists) abort();
    memcpy(lists, blob + 24, 4 * ((size_t)formats + present_modes + alpha_modes));
    capabilities->usages = rd64(blob);
    capabilities->formatCount = formats;
    capabilities->formats = (WGPUTextureFormat const*)lists;
    capabilities->presentModeCount = present_modes;
    capabilities->presentModes = (WGPUPresentMode const*)(lists + formats);
    capabilities->alphaModeCount = alpha_modes;
    capabilities->alphaModes = (WGPUCompositeAlphaMode const*)(lists + formats + present_modes);
    free(blob);
    return WGPUStatus_Success;
}

void wgpuSurfaceCapabilitiesFreeMembers(WGPUSurfaceCapabilities surfaceCapabilities) {
    free((void*)surfaceCapabilities.formats);
}
