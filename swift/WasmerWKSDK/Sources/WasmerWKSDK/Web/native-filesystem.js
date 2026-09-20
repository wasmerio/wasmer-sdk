// WKScriptMessage transports strings efficiently; arrays of bytes otherwise
// become thousands of boxed numbers on every native read and write. Only the
// WebKit hop uses base64. Worker replies use the SDK's binary shared buffer.
function encode(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16 * 1024));
  }
  return btoa(text);
}

function decode(value) {
  return typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(value) :
    Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export async function callNativeFileSystem(request, send) {
  let { method, args } = request;
  if (method === "write") {
    method = "writeBytes";
    args = [args[0], args[1], encode(Uint8Array.from(args[2]))];
  } else if (method === "read") {
    method = "readBytes";
  }
  const result = await send({ kind: "filesystem", mount: request.mount, method, args });
  if (method === "readBytes" && !result.error) return { value: decode(result.value) };
  return result;
}
