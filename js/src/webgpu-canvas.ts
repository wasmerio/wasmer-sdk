/**
 * WebGPU surfaces: how a guest in a worker draws to a canvas of the page.
 *
 * A guest that creates a surface names a canvas by selector. Its worker asks
 * the thread that owns the sandbox for that canvas over a private
 * `MessagePort`, and the owner answers in one of two ways:
 *
 * - An `OffscreenCanvas` moves to the worker for good. The guest then presents
 *   to it directly, without this thread taking part. The worker keeps it, so
 *   later surfaces created there for the same selector get it again.
 * - For an `HTMLCanvasElement` the guest renders into a canvas of its own and
 *   sends every presented frame back as an `ImageBitmap`, which is shown in
 *   the element. The element stays with the page, so any number of commands
 *   can present to it, one after another.
 */

export const WEBGPU_CANVAS_MESSAGE = "wasmer-webgpu-canvas";

/** A canvas a guest may present to. */
export type WebGpuCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Chooses the canvas for a selector at the moment a guest creates a surface
 * for it. Returning nothing refuses the surface.
 */
export type WebGpuCanvasProvider = (selector: string) => WebGpuCanvas | null | undefined;

interface CanvasRequest {
  type: typeof WEBGPU_CANVAS_MESSAGE;
  scope: number;
  selector: string;
  port: MessagePort;
}

type CanvasReply =
  /** The canvas itself; `key` names it for the worker that now owns it. */
  | { kind: "offscreen"; canvas: OffscreenCanvas; key: string }
  /** The canvas was given to a worker before, under `key`. */
  | { kind: "transferred"; key: string }
  | { kind: "frames"; width: number; height: number }
  | { kind: "missing"; reason: string };

/** Worker to owner, while a guest presents frames to an element. */
type FrameMessage = { type: "frame"; bitmap: ImageBitmap } | { type: "close" };

/** Owner to worker: the page gave the element another size. */
interface SizeMessage {
  type: "size";
  width: number;
  height: number;
}

/**
 * What the WebGPU host of a guest receives for a selector: the canvas to
 * configure, and for frames shown elsewhere, how to hand one over.
 */
interface CanvasBinding {
  canvas: OffscreenCanvas;
  /** The size the page would like the guest to render at. */
  getSize(): [number, number];
  present(): void;
  release(): void;
}

/** The canvases one sandbox may present to. */
export class WebGpuCanvases {
  readonly scope: number;
  readonly #bySelector = new Map<string, WebGpuCanvas>();
  #fallback: WebGpuCanvas | undefined;
  #provider: WebGpuCanvasProvider | undefined;
  /** Keys of the canvases that moved to a worker and were not replaced since. */
  readonly #given = new Set<string>();
  readonly #links = new Set<MessagePort>();
  #closed = false;

  constructor() {
    installWebGpuCanvasHandler();
    this.scope = nextScope++;
    registries.set(this.scope, this);
  }

  /** Set, replace or (with `undefined`) remove a canvas. No selector: the default canvas. */
  set(canvas: WebGpuCanvas | undefined, selector?: string): void {
    if (canvas !== undefined && !isCanvas(canvas)) {
      throw new TypeError("expected an HTMLCanvasElement or an OffscreenCanvas");
    }
    if (selector === undefined) this.#fallback = canvas;
    else if (canvas === undefined) this.#bySelector.delete(selector);
    else this.#bySelector.set(selector, canvas);
    // Whatever a worker holds for this name is no longer what guests get.
    this.#given.delete(keyOf(selector));
  }

  /**
   * The element set for a selector (or as the default canvas), if it is one
   * that stays with the page. It is not given away by being looked at.
   */
  element(selector?: string): HTMLCanvasElement | undefined {
    const canvas = selector === undefined ? this.#fallback : this.#bySelector.get(selector);
    return canvas !== undefined && isElement(canvas) ? canvas : undefined;
  }

  /** Who is asked for the canvas of a selector that none was set for. */
  setProvider(provider: WebGpuCanvasProvider | undefined): void {
    if (provider !== undefined && typeof provider !== "function") {
      throw new TypeError("expected a function that returns a canvas");
    }
    this.#provider = provider;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    registries.delete(this.scope);
    for (const port of this.#links) port.close();
    this.#links.clear();
    this.#bySelector.clear();
    this.#given.clear();
    this.#fallback = undefined;
    this.#provider = undefined;
  }

  /** Answer a guest that created a surface for `selector`. */
  serve(selector: string, port: MessagePort): void {
    const named = this.#bySelector.get(selector);
    let canvas = named ?? this.#fallback;
    let provided = false;
    if (!canvas && this.#provider) {
      // Asked for every surface: what it answers is not remembered here.
      try {
        const answer = this.#provider(selector) ?? undefined;
        if (answer !== undefined && !isCanvas(answer)) {
          throw new TypeError("expected an HTMLCanvasElement or an OffscreenCanvas");
        }
        canvas = answer;
        provided = answer !== undefined;
      } catch (error) {
        refuse(port, `the canvas provider failed: ${String(error)}`);
        return;
      }
    }
    if (!canvas) {
      // A canvas that moved to a worker is still that worker's to draw to.
      for (const key of [keyOf(selector), keyOf(undefined)]) {
        if (this.#given.has(key)) {
          port.postMessage({ kind: "transferred", key } satisfies CanvasReply);
          port.close();
          return;
        }
      }
      refuse(port, `this sandbox has no canvas for the selector ${JSON.stringify(selector)}`);
      return;
    }
    if (!isElement(canvas)) {
      // The canvas can be given away once. It is forgotten here and
      // remembered as given, so that a later request is pointed at the
      // worker that has it instead of at a canvas that is no longer here.
      const key = keyOf(named || provided ? selector : undefined);
      if (named) this.#bySelector.delete(selector);
      else if (!provided) this.#fallback = undefined;
      try {
        port.postMessage({ kind: "offscreen", canvas, key } satisfies CanvasReply, [canvas]);
        this.#given.add(key);
        port.close();
      } catch (error) {
        refuse(port, `the canvas could not be transferred: ${String(error)}`);
      }
      return;
    }

    let target: ImageBitmapRenderingContext | null = null;
    try {
      target = canvas.getContext("bitmaprenderer");
    } catch {
      // Reported below: a canvas that was transferred has no contexts here.
    }
    if (!target) {
      refuse(port, "the canvas already has a rendering context of another kind");
      return;
    }
    const frames = target;
    let width = canvas.width;
    let height = canvas.height;
    this.#links.add(port);
    port.onmessage = ({ data }: MessageEvent<FrameMessage>) => {
      if (data?.type === "frame") {
        try {
          frames.transferFromImageBitmap(data.bitmap);
        } catch {
          // The element lost its context (it left the document, say): the
          // frame has nowhere to go, and the guest need not hear about it.
          data.bitmap.close();
        }
        if (canvas.width !== width || canvas.height !== height) {
          width = canvas.width;
          height = canvas.height;
          port.postMessage({ type: "size", width, height } satisfies SizeMessage);
        }
      } else if (data?.type === "close") {
        this.#links.delete(port);
        port.close();
      }
    };
    port.postMessage({ kind: "frames", width, height } satisfies CanvasReply);
  }
}

const registries = new Map<number, WebGpuCanvases>();
let nextScope = 1;

/** Names a canvas of a sandbox: by its selector, or as the default one. */
function keyOf(selector: string | undefined): string {
  return selector === undefined ? "default" : `selector:${selector}`;
}

function refuse(port: MessagePort, reason: string): void {
  port.postMessage({ kind: "missing", reason } satisfies CanvasReply);
  port.close();
}

function isElement(canvas: WebGpuCanvas): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement;
}

function isCanvas(value: unknown): value is WebGpuCanvas {
  return (
    (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas)
  );
}

function isCanvasRequest(value: unknown): value is CanvasRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === WEBGPU_CANVAS_MESSAGE
  );
}

/**
 * Receive canvas requests from the SDK's workers on this thread. The worker
 * pool offers every worker message to `__wasmerHandleWebGpuRpc` first.
 */
function installWebGpuCanvasHandler(): void {
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.__wasmerHandleWebGpuRpc === "function") return;
  scope.__wasmerHandleWebGpuRpc = (message: unknown): boolean => {
    if (!isCanvasRequest(message)) return false;
    const registry = registries.get(message.scope);
    if (registry) registry.serve(String(message.selector), message.port);
    else refuse(message.port, "the sandbox was closed, or was not granted a canvas");
    return true;
  };
}

/**
 * Whether guests can use WebGPU here at all. Everything WebGPU reports arrives
 * through the worker's event loop, which a guest can only wait for when the
 * engine can suspend it (WebAssembly JSPI).
 */
export function webGpuGuestsSupported(): boolean {
  const api = WebAssembly as unknown as { Suspending?: unknown; promising?: unknown };
  return typeof api.Suspending === "function" && typeof api.promising === "function";
}

/**
 * Worker side: resolve the canvases a guest names through the thread that
 * owns the sandbox. Installed once in every SDK worker.
 */
export function installWebGpuCanvasWorkerBridge(): void {
  const scope = globalThis as Record<string, unknown>;
  /** The canvases that moved to this worker, by sandbox and key. */
  const owned = new Map<string, OffscreenCanvas>();
  const refused = (selector: string, reason: string): null => {
    console.warn(`[wasmer-webgpu] no canvas for ${JSON.stringify(selector)}: ${reason}`);
    return null;
  };
  scope.__wasmerWebGpuGetCanvas = (
    selector: string,
    canvasScope: number,
  ): Promise<OffscreenCanvas | CanvasBinding | null> =>
    new Promise((resolve) => {
      const { port1: port, port2 } = new MessageChannel();
      port.onmessage = ({ data }: MessageEvent<CanvasReply>) => {
        if (data?.kind === "offscreen") {
          port.close();
          owned.set(`${canvasScope}/${data.key}`, data.canvas);
          resolve(data.canvas);
        } else if (data?.kind === "transferred") {
          port.close();
          resolve(
            owned.get(`${canvasScope}/${data.key}`) ??
              refused(selector, "the canvas was given to another guest thread"),
          );
        } else if (data?.kind === "frames") {
          resolve(frameBinding(port, data.width, data.height));
        } else {
          port.close();
          resolve(refused(selector, data?.reason ?? "no answer"));
        }
      };
      globalThis.postMessage(
        {
          type: WEBGPU_CANVAS_MESSAGE,
          scope: canvasScope,
          selector,
          port: port2,
        } satisfies CanvasRequest,
        { transfer: [port2] },
      );
    });
}

function frameBinding(port: MessagePort, width: number, height: number): CanvasBinding {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  let size: [number, number] = [width, height];
  port.onmessage = ({ data }: MessageEvent<SizeMessage>) => {
    if (data?.type === "size") size = [data.width, data.height];
  };
  return {
    canvas,
    getSize: () => size,
    present() {
      const bitmap = canvas.transferToImageBitmap();
      port.postMessage({ type: "frame", bitmap } satisfies FrameMessage, [bitmap]);
    },
    release() {
      port.postMessage({ type: "close" } satisfies FrameMessage);
      port.close();
    },
  };
}
