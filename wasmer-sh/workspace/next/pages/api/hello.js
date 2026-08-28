export default function handler(_request, response) {
  response.status(200).json({ hello: "from Next.js on Wasmer" });
}
