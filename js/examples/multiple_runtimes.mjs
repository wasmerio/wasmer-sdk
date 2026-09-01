import { Wasmer } from "@wasmer/sdk2/node";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: [
    "python/python@=3.13.5",
    "wasmer/edgejs@0.2.0",
    "php/php-32",
  ],
});

try {
  const commands = [
    ["echo", ["hello from shell tools"]],
    ["python", ["-c", "print('hello from Python')"]],
    ["edge", ["-e", 'console.log("hello from Edge.js")']],
    ["php", ["-r", "echo 'hello from PHP';"]],
  ];

  for (const [executable, args] of commands) {
    const output = await sandbox
      .command(executable, args)
      .run();
    console.log(output.text().trim());
  }
} finally {
  await sandbox.close();
  await wasmer.close();
}
