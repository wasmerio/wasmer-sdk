declare module "@mercuryworkshop/wisp-js/client" {
  export namespace client {
    class ClientConnection {
      constructor(
        url: string,
        options?: { wisp_version?: number; wisp_extensions?: unknown[] },
      );
      connected: boolean;
      onopen: () => void;
      onclose: () => void;
      onerror: () => void;
      create_stream(hostname: string, port: number, type?: "tcp" | "udp"): ClientStream;
      close(): void;
    }

    interface ClientStream {
      open: boolean;
      onmessage: (data: Uint8Array) => void;
      onclose: (reason?: number) => void;
      send(data: Uint8Array): void;
      close(reason?: number): void;
    }
  }
}
