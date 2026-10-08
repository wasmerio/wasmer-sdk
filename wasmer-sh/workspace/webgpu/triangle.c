// A spinning triangle: the smallest program that presents to a surface, and
// the frame loop a native WebGPU program writes.
//
// Build and run it here in the terminal:
//
//     clang -Iinclude triangle.c lib/*.c -o triangle.wasm
//     ./triangle.wasm            draws until you press Ctrl-C
//     ./triangle.wasm 300        draws 300 frames, then exits
//
// include/ holds the standard webgpu.h, and lib/ Wasmer's implementation of
// it for WASIX programs. The canvas opens beside the terminal when the
// program creates its surface.

#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <webgpu/webgpu.h>
#include <webgpu/webgpu_wasix.h>

#define SV(text) ((WGPUStringView){ (text), WGPU_STRLEN })

static const char kShader[] =
    "struct Frame { angle: f32, aspect: f32 }\n"
    "@group(0) @binding(0) var<uniform> frame: Frame;\n"
    "struct Vertex { @builtin(position) position: vec4f, @location(0) color: vec3f }\n"
    "@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {\n"
    "    let corners = array(vec2f(0.0, 0.7), vec2f(-0.6, -0.5), vec2f(0.6, -0.5));\n"
    "    let colors = array(vec3f(1.0, 0.2, 0.2), vec3f(0.2, 1.0, 0.2), vec3f(0.2, 0.4, 1.0));\n"
    "    let c = cos(frame.angle);\n"
    "    let s = sin(frame.angle);\n"
    "    let p = corners[index];\n"
    "    let turned = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);\n"
    "    return Vertex(vec4f(turned.x / frame.aspect, turned.y, 0.0, 1.0), colors[index]);\n"
    "}\n"
    "@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {\n"
    "    return vec4f(vertex.color, 1.0);\n"
    "}\n";

static bool device_lost;

// Set by Ctrl-C. The loop notices before its next frame, and the program
// leaves the way it does after its last one.
static volatile sig_atomic_t interrupted;

static void on_interrupt(int number) {
    (void)number;
    interrupted = 1;
}

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
    // Destroying the device ourselves at exit is not news.
    if (reason != WGPUDeviceLostReason_Destroyed)
        fprintf(stderr, "device lost: %.*s\n", (int)message.length, message.data);
    device_lost = true;
}

static void on_error(WGPUDevice const* device, WGPUErrorType type, WGPUStringView message, void* userdata1,
                     void* userdata2) {
    (void)device; (void)userdata1; (void)userdata2;
    fprintf(stderr, "WebGPU error (type %d): %.*s\n", (int)type, (int)message.length, message.data);
}

// Blocks until `future` completes; its callback has run by then.
static void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo info = { future, false };
    wgpuInstanceWaitAny(instance, 1, &info, UINT64_MAX);
}

static double seconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

typedef struct Target {
    WGPUSurface surface;
    WGPUDevice device;
    WGPUTextureFormat format;
    WGPUCompositeAlphaMode alpha;
    uint32_t width, height;
} Target;

// Sizes the surface for what it presents to right now.
static void configure(Target* target) {
    if (wgpuWasixSurfaceGetSize(target->surface, &target->width, &target->height) != WGPUStatus_Success ||
        target->width == 0 || target->height == 0) {
        // Minimized, or not laid out yet: keep the size we had.
        if (target->width == 0 || target->height == 0) return;
    }
    WGPUSurfaceConfiguration configuration = WGPU_SURFACE_CONFIGURATION_INIT;
    configuration.device = target->device;
    configuration.format = target->format;
    configuration.usage = WGPUTextureUsage_RenderAttachment;
    configuration.width = target->width;
    configuration.height = target->height;
    configuration.alphaMode = target->alpha;
    configuration.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(target->surface, &configuration);
}

int main(int argc, char** argv) {
    uint64_t frames = argc > 1 ? strtoull(argv[1], NULL, 10) : 0;
    signal(SIGINT, on_interrupt);

    // Waiting with a timeout (here: forever) is an instance feature.
    static const WGPUInstanceFeatureName kFeatures[] = { WGPUInstanceFeatureName_TimedWaitAny };
    WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = kFeatures;
    WGPUInstance instance = wgpuCreateInstance(&instance_descriptor);
    if (!instance) {
        fprintf(stderr, "WebGPU is not available\n");
        return 1;
    }

    // The host decides what the surface presents to: a window, a canvas of
    // the page, or nothing visible at all. The selector names it.
    WGPUWasixSurfaceSourceCanvas source = WGPU_WASIX_SURFACE_SOURCE_CANVAS_INIT;
    source.selector = SV("#canvas");
    WGPUSurfaceDescriptor surface_descriptor = WGPU_SURFACE_DESCRIPTOR_INIT;
    surface_descriptor.nextInChain = &source.chain;
    WGPUSurface surface = wgpuInstanceCreateSurface(instance, &surface_descriptor);
    if (!surface) {
        fprintf(stderr, "the host has nothing to present to\n");
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
        fprintf(stderr, "the adapter cannot present to this surface\n");
        return 1;
    }
    Target target = { surface, device, capabilities.formats[0], capabilities.alphaModes[0], 0, 0 };
    wgpuSurfaceCapabilitiesFreeMembers(capabilities);
    configure(&target);

    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = SV(kShader);
    WGPUShaderModuleDescriptor shader_descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    shader_descriptor.nextInChain = &wgsl.chain;
    WGPUShaderModule shader = wgpuDeviceCreateShaderModule(device, &shader_descriptor);

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = target.format;
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

    // { angle, aspect }, rewritten every frame.
    WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    uniform_descriptor.size = 2 * sizeof(float);
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

    double start = seconds();
    uint64_t presented = 0;
    while (!device_lost && !interrupted && (frames == 0 || presented < frames)) {
        // Callbacks (the device-lost one, here) run from this call.
        wgpuInstanceProcessEvents(instance);

        WGPUSurfaceTexture frame = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(surface, &frame);
        bool reconfigure = false;
        switch (frame.status) {
            case WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal:
                break;
            case WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal:
                // Still drawable, but the target changed (it was resized):
                // show this frame, then match the new size.
                reconfigure = true;
                break;
            case WGPUSurfaceGetCurrentTextureStatus_Timeout:
                // Nothing to draw to right now (a hidden window): try again.
                continue;
            case WGPUSurfaceGetCurrentTextureStatus_Outdated:
            case WGPUSurfaceGetCurrentTextureStatus_Lost:
                if (frame.texture) wgpuTextureRelease(frame.texture);
                configure(&target);
                continue;
            default:
                fprintf(stderr, "cannot get a frame to draw to\n");
                return 1;
        }

        // Headless hosts have no clock to keep: there a frame is a fixed step.
        float angle = frames != 0 ? (float)presented * 0.05f : (float)(seconds() - start);
        float values[2] = { angle, (float)target.width / (float)target.height };
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
        if (reconfigure) configure(&target);
    }
    printf("presented %llu frames\n", (unsigned long long)presented);

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
    return 0;
}
