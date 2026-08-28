export default function handler(_request, response) {
  response.status(200).json({ hello: "from Vinext on Wasmer" });
}
