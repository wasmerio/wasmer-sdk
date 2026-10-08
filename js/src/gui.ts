/**
 * Windows for guests: canvases of the page.
 *
 * A guest built against `<wasmer/gui.h>` opens windows. In a browser a
 * window is an `HTMLCanvasElement` the page gave the sandbox: what the user
 * does on it reaches the guest as input, and what the guest asks of its
 * window (a cursor, fullscreen, text entry) is done to the canvas. The page
 * half of wasmer-gui does that work; this file is how a sandbox says which
 * canvases its guests may have.
 */

import type { WebGpuCanvases } from "./webgpu-canvas.js";

/**
 * Chooses the canvas for a window at the moment a guest opens it. `target`
 * is the name the guest gave (`WGUIWindowDescriptor.target`), `""` when it
 * gave none. Returning nothing refuses the window.
 */
export type GuiCanvasProvider = (target: string) => HTMLCanvasElement | null | undefined;

/** What guests may do with their windows. Unset is the default. */
export interface GuiPermissions {
  /** Go fullscreen. Default: yes. */
  fullscreen?: boolean;
  /** Lock the cursor to a window (pointer lock). Default: yes. */
  cursorLock?: boolean;
  /** Show cursor images of their own. Default: yes. */
  customCursors?: boolean;
  /** Have text entered, with the system's input methods. Default: yes. */
  textInput?: boolean;
  /** Put text on the clipboard. Default: yes. */
  clipboardWrite?: boolean;
  /**
   * Read the clipboard: never, only right after the user pastes into the
   * guest's window (the default), or whenever the browser lets the page.
   */
  clipboardRead?: "deny" | "on-paste" | "allow";
  /** Read the mouse's movement while the cursor is locked. Default: yes. */
  rawInput?: boolean;
}

/** Ceilings on what one command may hold. Unset is the default. */
export interface GuiLimits {
  /** Windows open at once. */
  maxWindows?: number;
  /** Event records waiting to be read, before the oldest input is dropped. */
  maxPendingEvents?: number;
}

export interface GuiOptions {
  /**
   * The canvas a guest's window is when it opens one without naming a
   * target, or a function that is asked for the canvas of every window that
   * `canvases` does not list.
   */
  canvas?: HTMLCanvasElement | GuiCanvasProvider;
  /** Canvases by the target the guest names (`WGUIWindowDescriptor.target`). */
  canvases?: Readonly<Record<string, HTMLCanvasElement>>;
  permissions?: GuiPermissions;
  limits?: GuiLimits;
  /**
   * Called when a guest gives its window a title, or another one; and with
   * an empty title when the window is gone and the canvas the page's again.
   */
  onTitle?: (title: string, canvas: HTMLCanvasElement) => void;
  /**
   * `false` keeps guests from asking for a size: the page's layout alone
   * decides how big a canvas is. Otherwise a guest's wish is set as the
   * canvas's CSS size, which the layout may still overrule.
   */
  resizable?: boolean;
}

/** The windows of a sandbox that was granted a GUI. */
export interface SandboxGui {
  /** Whether the sandbox was created with `gui`. */
  readonly enabled: boolean;
  /**
   * Add, replace or (with `undefined`) remove a canvas. Without a target it
   * is the default canvas. A window that is already open keeps its canvas.
   */
  setCanvas(canvas: HTMLCanvasElement | undefined, target?: string): void;
}

let nextScope = 1;

function isElement(value: unknown): value is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement;
}

/** The canvases one sandbox's guests may have as windows. */
export class GuiWindows {
  /** Names this sandbox's GUI among those of the page. */
  readonly scope: number;
  readonly #byTarget = new Map<string, HTMLCanvasElement>();
  #fallback: HTMLCanvasElement | undefined;
  #provider: GuiCanvasProvider | undefined;
  readonly #options: GuiOptions;
  /** Where WebGPU looks canvases up, when the sandbox also has that. */
  readonly #drawing: WebGpuCanvases | undefined;
  #close: ((scope: number) => void) | undefined;

  constructor(options: GuiOptions, drawing: WebGpuCanvases | undefined) {
    this.scope = nextScope++;
    this.#options = options;
    this.#drawing = drawing;
    if (typeof options.canvas === "function") this.#provider = options.canvas;
    else if (options.canvas !== undefined) this.set(options.canvas);
    for (const [target, canvas] of Object.entries(options.canvases ?? {})) {
      this.set(canvas, target);
    }
    if (options.onTitle !== undefined && typeof options.onTitle !== "function") {
      throw new TypeError("gui.onTitle must be a function");
    }
  }

  set(canvas: HTMLCanvasElement | undefined, target?: string): void {
    if (canvas !== undefined && !isElement(canvas)) {
      throw new TypeError("a window has to be an HTMLCanvasElement");
    }
    if (target === undefined || target === "") this.#fallback = canvas;
    else if (canvas === undefined) this.#byTarget.delete(target);
    else this.#byTarget.set(target, canvas);
  }

  /** What the Rust half is given, as plain data. */
  settings(): Record<string, unknown> {
    const settings: Record<string, unknown> = { scope: this.scope };
    for (const [name, value] of Object.entries(this.#options.permissions ?? {})) {
      if (value !== undefined) settings[name] = value;
    }
    for (const [name, value] of Object.entries(this.#options.limits ?? {})) {
      if (value !== undefined) settings[name] = value;
    }
    return settings;
  }

  /** What the page half of wasmer-gui is given. */
  page(): Record<string, unknown> {
    return {
      resolveCanvas: (target: string): HTMLCanvasElement | null => {
        const named = target === "" ? this.#fallback : this.#byTarget.get(target);
        if (named) return named;
        const provided = this.#provider?.(target) ?? undefined;
        if (provided !== undefined) {
          if (!isElement(provided)) throw new TypeError("a window has to be an HTMLCanvasElement");
          return provided;
        }
        // A canvas the sandbox was given to draw on is one a guest can have
        // as the window it draws in.
        return this.#drawing?.element(target === "" ? undefined : target) ?? null;
      },
      alias: (selector: string, canvas: HTMLCanvasElement | undefined): void => {
        this.#drawing?.set(canvas, selector);
      },
      title: this.#options.onTitle,
      resizable: this.#options.resizable !== false,
    };
  }

  /** Remembers how to tell the Rust half that the sandbox is gone. */
  opened(close: (scope: number) => void): void {
    this.#close = close;
  }

  close(): void {
    const close = this.#close;
    this.#close = undefined;
    this.#byTarget.clear();
    this.#fallback = undefined;
    this.#provider = undefined;
    close?.(this.scope);
  }
}
