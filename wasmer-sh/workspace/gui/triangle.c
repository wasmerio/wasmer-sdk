// A triangle you can take hold of: the smallest program that has a window,
// draws to it with WebGPU, and listens to the user.
//
//   drag, or the arrow keys     turn it            the wheel     make it bigger or smaller
//   F                           fullscreen         L             lock the cursor: the mouse turns it
//   Space                       let it spin        Escape, Q     let go of the cursor, then leave
//
// Build (after `make guest` in wasmer-webgpu, here at ../webgpu):
//
//     wasixcc examples/triangle.c -Iinclude -I../webgpu/include \
//         -L../webgpu/lib/wasm32-wasix -lwebgpu -o triangle.wasm
//
// Run:
//
//     gui_wasmer --window --webgpu triangle.wasm      a native window
//     gui_wasmer --webgpu triangle.wasm 60            headless: 60 frames, nobody watching
//
// usage: triangle [frames]        (no count: run until the window is closed, or Ctrl-C)

#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wasmer/gui.h>
#include <webgpu/webgpu.h>
#include <webgpu/webgpu_wasix.h>

#define SV(text) ((WGPUStringView){ (text), WGPU_STRLEN })

static const char kShader[] =
    "struct Frame { angle: f32, aspect: f32, scale: f32, glow: f32 }\n"
    "@group(0) @binding(0) var<uniform> frame: Frame;\n"
    "struct Vertex { @builtin(position) position: vec4f, @location(0) color: vec3f }\n"
    "@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {\n"
    "    let corners = array(vec2f(0.0, 0.7), vec2f(-0.6, -0.5), vec2f(0.6, -0.5));\n"
    "    let colors = array(vec3f(1.0, 0.2, 0.2), vec3f(0.2, 1.0, 0.2), vec3f(0.2, 0.4, 1.0));\n"
    "    let c = cos(frame.angle);\n"
    "    let s = sin(frame.angle);\n"
    "    let p = corners[index] * frame.scale;\n"
    "    let turned = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);\n"
    "    return Vertex(vec4f(turned.x / frame.aspect, turned.y, 0.0, 1.0), colors[index]);\n"
    "}\n"
    "@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {\n"
    "    return vec4f(mix(vertex.color, vec3f(1.0), frame.glow), 1.0);\n"
    "}\n";

// -- what the user has done -------------------------------------------------------

// Set by Ctrl-C in the terminal the program was started from. Signals reach a
// program where it asks and waits for events, so the handler runs inside those
// calls, and the loop finds this set when they return.
static volatile sig_atomic_t interrupted;

static void on_interrupt(int number) {
    (void)number;
    interrupted = 1;
}

typedef struct State {
    WGUIInstance gui;
    WGUIWindow window;
    uint32_t width, height;   // of the window's content, in physical pixels
    bool resized;             // the surface has to be configured again
    bool hidden;              // nothing of the window can be seen
    bool running;
    bool spinning;
    bool dragging;
    bool locked;
    bool fullscreen;
    float angle, scale;
    uint64_t next_tag;
} State;

static void handle_key(State* state, const WGUIKeyEvent* key) {
    const float step = 0.1f;
    switch (key->physicalKey) {
        case WGUIPhysicalKey_ArrowLeft: state->angle += step; break;
        case WGUIPhysicalKey_ArrowRight: state->angle -= step; break;
        case WGUIPhysicalKey_ArrowUp: state->scale *= 1.1f; break;
        case WGUIPhysicalKey_ArrowDown: state->scale /= 1.1f; break;
        default: break;
    }
    if (key->keyFlags & WGUIKeyFlags_Repeat) {
        return;
    }
    switch (key->physicalKey) {
        case WGUIPhysicalKey_Space:
            state->spinning = !state->spinning;
            break;
        case WGUIPhysicalKey_KeyF: {
            // Enters fullscreen, or leaves it with no options. The answer
            // comes as events: a request completed, flags changed, a resize.
            WGUIFullscreenOptions options = WGUI_FULLSCREEN_OPTIONS_INIT;
            wguiWindowSetFullscreen(state->window, state->fullscreen ? NULL : &options, state->next_tag++);
            break;
        }
        case WGUIPhysicalKey_KeyL:
            // Not every host can lock the cursor; this one says if it cannot.
            if (wguiWindowSetCursorGrab(state->window, state->locked ? WGUICursorGrab_None : WGUICursorGrab_Locked,
                                        state->next_tag++) == WGUIStatus_Unsupported) {
                fprintf(stderr, "this host cannot lock the cursor\n");
            }
            break;
        case WGUIPhysicalKey_Escape:
            if (state->locked) {
                wguiWindowSetCursorGrab(state->window, WGUICursorGrab_None, state->next_tag++);
                break;
            }
            state->running = false;
            break;
        case WGUIPhysicalKey_KeyQ:
            state->running = false;
            break;
        default:
            break;
    }
}

static void handle_event(State* state, const WGUIEventHeader* event) {
    switch (event->type) {
        case WGUIEventType_WindowResized: {
            const WGUIWindowResizedEvent* size = (const WGUIWindowResizedEvent*)event;
            state->width = size->width;
            state->height = size->height;
            state->resized = true;
            break;
        }
        case WGUIEventType_WindowFlagsChanged: {
            const WGUIWindowFlagsChangedEvent* change = (const WGUIWindowFlagsChangedEvent*)event;
            state->fullscreen = (change->flags & WGUIWindowFlags_Fullscreen) != 0;
            state->hidden = (change->flags & (WGUIWindowFlags_Occluded | WGUIWindowFlags_Minimized)) != 0;
            break;
        }
        case WGUIEventType_WindowCursorGrabChanged:
            // The grab is lent: the user or the system can take it back.
            state->locked = ((const WGUIWindowCursorGrabChangedEvent*)event)->grab == WGUICursorGrab_Locked;
            break;
        case WGUIEventType_WindowCloseRequested:
            state->running = false;
            break;
        case WGUIEventType_KeyDown:
            handle_key(state, (const WGUIKeyEvent*)event);
            break;
        case WGUIEventType_PointerDown:
        case WGUIEventType_PointerUp: {
            const WGUIPointerEvent* pointer = (const WGUIPointerEvent*)event;
            if (pointer->pointerFlags & WGUIPointerFlags_Primary) {
                state->dragging = (pointer->buttons & WGUIPointerButtons_Primary) != 0;
            }
            break;
        }
        case WGUIEventType_PointerMotion: {
            const WGUIPointerEvent* pointer = (const WGUIPointerEvent*)event;
            // With the cursor locked there is no position, only movement.
            if ((state->dragging || state->locked) && (pointer->pointerFlags & WGUIPointerFlags_Primary)) {
                state->angle -= (float)pointer->deltaX * 0.01f;
            }
            break;
        }
        case WGUIEventType_Wheel: {
            const WGUIWheelEvent* wheel = (const WGUIWheelEvent*)event;
            float notches = (float)wheel->deltaY * (wheel->unit == WGUIWheelUnit_Pixel ? 0.01f : 1.0f);
            state->scale *= powf(1.1f, -notches);
            break;
        }
        default:
            break;
    }
    if (state->scale < 0.1f) state->scale = 0.1f;
    if (state->scale > 3.0f) state->scale = 3.0f;
}

// Reads what has happened since the last frame. With nothing to draw to, it
// waits for something to happen instead of spinning.
static void pump(State* state) {
    static uint64_t buffer[2 * WGUI_MAX_EVENT_SIZE / 8];
    for (;;) {
        size_t written = 0;
        if (wguiInstancePollEvents(state->gui, buffer, sizeof buffer, &written) != WGUIStatus_Success) {
            return;
        }
        const WGUIEventHeader* event = wguiEventFirst(buffer, written);
        for (; event != NULL; event = wguiEventNext(buffer, written, event)) {
            handle_event(state, event);
        }
        if (written != 0) {
            continue;
        }
        if (!state->hidden || !state->running || interrupted) {
            return;
        }
        // The host ends a long wait now and then, for signals: around again.
        WGUIWaitReasons reasons = 0;
        wguiInstanceWaitEvents(state->gui, WGUI_WAIT_FOREVER, &reasons);
    }
}

// -- WebGPU -------------------------------------------------------------------------

static bool device_lost;

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void* userdata1,
                       void* userdata2) {
    (void)userdata2;
    if (status != WGPURequestAdapterStatus_Success)
        fprintf(stderr, "no adapter: %.*s\n", (int)message.length, message.data);
    *(WGPUAdapter*)userdata1 = adapter;
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void* userdata1,
                      void* userdata2) {
    (void)userdata2;
    if (status != WGPURequestDeviceStatus_Success)
        fprintf(stderr, "no device: %.*s\n", (int)message.length, message.data);
    *(WGPUDevice*)userdata1 = device;
}

static void on_device_lost(WGPUDevice const* device, WGPUDeviceLostReason reason, WGPUStringView message,
                           void* userdata1, void* userdata2) {
    (void)device; (void)userdata1; (void)userdata2;
    if (reason != WGPUDeviceLostReason_Destroyed)
        fprintf(stderr, "device lost: %.*s\n", (int)message.length, message.data);
    device_lost = true;
}

static void on_error(WGPUDevice const* device, WGPUErrorType type, WGPUStringView message, void* userdata1,
                     void* userdata2) {
    (void)device; (void)userdata1; (void)userdata2;
    fprintf(stderr, "WebGPU error (type %d): %.*s\n", (int)type, (int)message.length, message.data);
}

static void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo info = { future, false };
    wgpuInstanceWaitAny(instance, 1, &info, UINT64_MAX);
}

static void configure(WGPUSurface surface, WGPUDevice device, WGPUTextureFormat format, WGPUCompositeAlphaMode alpha,
                      const State* state) {
    WGPUSurfaceConfiguration configuration = WGPU_SURFACE_CONFIGURATION_INIT;
    configuration.device = device;
    configuration.format = format;
    configuration.usage = WGPUTextureUsage_RenderAttachment;
    // The window says how big it is, in the pixels a surface is made of.
    configuration.width = state->width;
    configuration.height = state->height;
    configuration.alphaMode = alpha;
    configuration.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &configuration);
}

int main(int argc, char** argv) {
    uint64_t frames = argc > 1 ? strtoull(argv[1], NULL, 10) : 0;
    signal(SIGINT, on_interrupt);

    State state = { 0 };
    state.running = true;
    state.spinning = true;
    state.scale = 1.0f;
    state.next_tag = 1;

    // The window first: its events tell its size, and its selector is what
    // the surface is created with.
    if (wguiCreateInstance(NULL, &state.gui) != WGUIStatus_Success) {
        fprintf(stderr, "no window system\n");
        return 1;
    }
    WGUIWindowDescriptor window_descriptor = WGUI_WINDOW_DESCRIPTOR_INIT;
    window_descriptor.title.data = "Triangle: drag, arrows, wheel, F, L, Space, Escape";
    window_descriptor.options = WGUIWindowOptions_LogicalUnits;
    window_descriptor.width = 640;
    window_descriptor.height = 480;
    if (wguiInstanceCreateWindow(state.gui, &window_descriptor, &state.window) != WGUIStatus_Success) {
        fprintf(stderr, "cannot open a window\n");
        return 1;
    }
    pump(&state);
    if (state.width == 0 || state.height == 0) {
        fprintf(stderr, "the window did not say how big it is\n");
        return 1;
    }
    char selector[128];
    size_t selector_length = 0;
    wguiWindowGetSurfaceSelector(state.window, selector, sizeof selector, &selector_length);
    if (selector_length > sizeof selector) {
        return 1;
    }

    static const WGPUInstanceFeatureName kFeatures[] = { WGPUInstanceFeatureName_TimedWaitAny };
    WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = kFeatures;
    WGPUInstance instance = wgpuCreateInstance(&instance_descriptor);
    if (!instance) {
        fprintf(stderr, "WebGPU is not available\n");
        return 1;
    }

    WGPUWasixSurfaceSourceCanvas source = WGPU_WASIX_SURFACE_SOURCE_CANVAS_INIT;
    source.selector = (WGPUStringView){ selector, selector_length };
    WGPUSurfaceDescriptor surface_descriptor = WGPU_SURFACE_DESCRIPTOR_INIT;
    surface_descriptor.nextInChain = &source.chain;
    WGPUSurface surface = wgpuInstanceCreateSurface(instance, &surface_descriptor);
    if (!surface) {
        fprintf(stderr, "the window cannot be drawn on\n");
        return 1;
    }

    WGPUAdapter adapter = NULL;
    WGPURequestAdapterOptions adapter_options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    adapter_options.compatibleSurface = surface;
    WGPURequestAdapterCallbackInfo adapter_callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.callback = on_adapter;
    adapter_callback.userdata1 = &adapter;
    wait_for(instance, wgpuInstanceRequestAdapter(instance, &adapter_options, adapter_callback));
    if (!adapter) return 1;

    WGPUDevice device = NULL;
    WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    device_descriptor.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    device_descriptor.deviceLostCallbackInfo.callback = on_device_lost;
    device_descriptor.uncapturedErrorCallbackInfo.callback = on_error;
    WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = on_device;
    device_callback.userdata1 = &device;
    wait_for(instance, wgpuAdapterRequestDevice(adapter, &device_descriptor, device_callback));
    if (!device) return 1;
    WGPUQueue queue = wgpuDeviceGetQueue(device);

    WGPUSurfaceCapabilities capabilities = WGPU_SURFACE_CAPABILITIES_INIT;
    if (wgpuSurfaceGetCapabilities(surface, adapter, &capabilities) != WGPUStatus_Success ||
        capabilities.formatCount == 0) {
        fprintf(stderr, "the adapter cannot present to this window\n");
        return 1;
    }
    WGPUTextureFormat format = capabilities.formats[0];
    WGPUCompositeAlphaMode alpha = capabilities.alphaModes[0];
    wgpuSurfaceCapabilitiesFreeMembers(capabilities);
    configure(surface, device, format, alpha, &state);
    state.resized = false;

    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = SV(kShader);
    WGPUShaderModuleDescriptor shader_descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    shader_descriptor.nextInChain = &wgsl.chain;
    WGPUShaderModule shader = wgpuDeviceCreateShaderModule(device, &shader_descriptor);

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = shader;
    fragment.entryPoint = SV("fragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor pipeline_descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pipeline_descriptor.vertex.module = shader;
    pipeline_descriptor.vertex.entryPoint = SV("vertex");
    pipeline_descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(device, &pipeline_descriptor);

    WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    uniform_descriptor.size = 4 * sizeof(float);
    uniform_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    WGPUBuffer uniforms = wgpuDeviceCreateBuffer(device, &uniform_descriptor);

    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.buffer = uniforms;
    entry.size = uniform_descriptor.size;
    WGPUBindGroupDescriptor bind_group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_group_descriptor.layout = layout;
    bind_group_descriptor.entryCount = 1;
    bind_group_descriptor.entries = &entry;
    WGPUBindGroup bind_group = wgpuDeviceCreateBindGroup(device, &bind_group_descriptor);

    uint64_t presented = 0;
    while (!device_lost && state.running && !interrupted && (frames == 0 || presented < frames)) {
        wgpuInstanceProcessEvents(instance);
        pump(&state);
        if (!state.running || interrupted) {
            break;
        }
        if (state.resized && state.width != 0 && state.height != 0) {
            configure(surface, device, format, alpha, &state);
            state.resized = false;
        }

        WGPUSurfaceTexture frame = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(surface, &frame);
        switch (frame.status) {
            case WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal:
            case WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal:
                break;
            case WGPUSurfaceGetCurrentTextureStatus_Timeout:
                continue;
            case WGPUSurfaceGetCurrentTextureStatus_Outdated:
            case WGPUSurfaceGetCurrentTextureStatus_Lost:
                if (frame.texture) wgpuTextureRelease(frame.texture);
                configure(surface, device, format, alpha, &state);
                continue;
            default:
                fprintf(stderr, "cannot get a frame to draw to\n");
                return 1;
        }

        if (state.spinning && !state.dragging && !state.locked) {
            state.angle += 0.01f;
        }
        float values[4] = { state.angle, (float)state.width / (float)state.height, state.scale,
                            state.locked ? 0.35f : 0.0f };
        wgpuQueueWriteBuffer(queue, uniforms, 0, values, sizeof values);

        WGPUTextureView view = wgpuTextureCreateView(frame.texture, NULL);
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = view;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
        attachment.clearValue = (WGPUColor){ 0.05, 0.05, 0.08, 1.0 };
        WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &attachment;

        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, NULL);
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, NULL);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL);
        wgpuQueueSubmit(queue, 1, &commands);
        wgpuCommandBufferRelease(commands);
        wgpuCommandEncoderRelease(encoder);
        wgpuTextureViewRelease(view);

        // Blocks until the frame is on its way to the screen, which is what
        // paces this loop.
        wgpuSurfacePresent(surface);
        wgpuTextureRelease(frame.texture);
        presented++;
    }
    printf("presented %llu frames at %ux%u\n", (unsigned long long)presented, state.width, state.height);

    wgpuBindGroupRelease(bind_group);
    wgpuBindGroupLayoutRelease(layout);
    wgpuBufferRelease(uniforms);
    wgpuRenderPipelineRelease(pipeline);
    wgpuShaderModuleRelease(shader);
    wgpuSurfaceUnconfigure(surface);
    wgpuSurfaceRelease(surface);
    wgpuQueueRelease(queue);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
    wguiWindowDestroy(state.window);
    wguiInstanceDestroy(state.gui);
    return 0;
}
