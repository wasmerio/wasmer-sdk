import type { NodeNetworkMethod } from "./node-network.js";

export const NETWORK_RPC_CONTROL_BYTES = 16;
const NETWORK_RPC_ERROR_BYTES = 512;

/** Size one synchronous worker response without a blanket payload reserve. */
export function networkResponseBufferBytes(
  method: NodeNetworkMethod,
  args: readonly unknown[],
): number {
  const requested =
    method === "socketRead" && typeof args[1] === "number"
      ? Math.max(0, Math.trunc(args[1]))
      : 0;
  return NETWORK_RPC_CONTROL_BYTES + Math.max(NETWORK_RPC_ERROR_BYTES, requested);
}
