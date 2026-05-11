import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const WASMER_BIN = process.env.WASMER_BIN ?? "wasmer";
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";
const WORDPRESS_PACKAGE = process.env.WASMER_WORDPRESS_PACKAGE ?? "wasmer/wordpress";
const WORDPRESS_HTTP_PORT = Number.parseInt(process.env.WASMER_WORDPRESS_HTTP_PORT ?? "", 10);
const WORDPRESS_DB_PORT = Number.parseInt(process.env.WASMER_WORDPRESS_DB_PORT ?? "", 10);
const WORDPRESS_DB_IMAGE = process.env.WASMER_WORDPRESS_DB_IMAGE ?? "mariadb:11";
const KEEP_FIXTURE = /^(1|true|yes)$/i.test(process.env.WASMER_WORDPRESS_KEEP_FIXTURE ?? "");

const ADMIN_USERNAME = "sdk-admin";
const ADMIN_PASSWORD = "sdk-admin-pass";
const ADMIN_EMAIL = "sdk-admin@example.com";
const SITE_TITLE = "SDK WordPress Test";
const REPO_ROOT = process.cwd();
const SDK_LITE_DIR = path.join(REPO_ROOT, "sdk-lite");
const SSH_USERNAME = "wasmer";
const SSH_PASSWORD = "sdk-ssh-pass";

let sdkLiteModulesPromise = null;

const delay = async (ms) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createRandomSuffix = () => Math.random().toString(36).slice(2, 10);

const stripAnsi = (value) => value.replace(/\u001b\[[0-9;]*m/g, "");

const toPhpStringLiteral = (value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const toWasmerEnvArgs = (env) =>
  Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);

const getFreePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Could not allocate a free port.");
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
};

const runCommand = async (
  command,
  args,
  options = {},
) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timer;

  if (options.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
  }

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });

  if (timer) {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new Error(
      `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
    );
  }

  return result;
};

const assertCommandOk = async (command, args, options = {}) => {
  const result = await runCommand(command, args, options);
  result.stdout = stripAnsi(result.stdout);
  result.stderr = stripAnsi(result.stderr);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed.\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
  );
  return result;
};

const startProcess = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];

  child.stdout?.on("data", (chunk) => {
    stdout.push(chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });

  return { child, stdout, stderr };
};

const stopProcess = async (running) => {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return;
  }

  running.child.kill("SIGTERM");
  const closed = await Promise.race([
    new Promise((resolve) => {
      running.child.once("close", () => resolve(true));
    }),
    delay(5_000).then(() => false),
  ]);

  if (!closed) {
    running.child.kill("SIGKILL");
    await new Promise((resolve) => {
      running.child.once("close", () => resolve());
    });
  }
};

const waitForHttp = async (url, deadlineMs = Date.now() + 120_000) => {
  let lastError = null;

  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`Unexpected HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await delay(1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
};

const waitForDockerDatabase = async (containerName, deadlineMs = Date.now() + 120_000) => {
  let lastError = null;

  while (Date.now() < deadlineMs) {
    const result = await runCommand(
      DOCKER_BIN,
      ["exec", containerName, "mariadb-admin", "ping", "--user=root", "--password=root-pass", "--silent"],
      { timeoutMs: 20_000 },
    );

    if (result.code === 0) {
      return;
    }

    lastError = result.stderr || result.stdout || `docker exec exited with code ${result.code}`;
    await delay(2_000);
  }

  throw new Error(`Timed out waiting for MariaDB container ${containerName}.\n${lastError ?? ""}`);
};

const getDatabaseConfig = async () => {
  const external = {
    database: process.env.WASMER_WORDPRESS_DB_NAME,
    host: process.env.WASMER_WORDPRESS_DB_HOST,
    password: process.env.WASMER_WORDPRESS_DB_PASSWORD,
    port: process.env.WASMER_WORDPRESS_DB_PORT,
    username: process.env.WASMER_WORDPRESS_DB_USERNAME,
  };

  if (external.database && external.host && external.password && external.port && external.username) {
    return {
      database: external.database,
      host: external.host,
      password: external.password,
      port: Number.parseInt(external.port, 10),
      username: external.username,
      cleanup: async () => {},
    };
  }

  const hostPort = Number.isFinite(WORDPRESS_DB_PORT) ? WORDPRESS_DB_PORT : await getFreePort();
  const containerName = `sdk-wordpress-db-${createRandomSuffix()}`;
  await assertCommandOk(DOCKER_BIN, [
    "run",
    "--rm",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${hostPort}:3306`,
    "--env",
    "MARIADB_DATABASE=wordpress",
    "--env",
    "MARIADB_USER=wordpress",
    "--env",
    "MARIADB_PASSWORD=wordpress",
    "--env",
    "MARIADB_ROOT_PASSWORD=root-pass",
    WORDPRESS_DB_IMAGE,
  ], { timeoutMs: 120_000 });

  try {
    await waitForDockerDatabase(containerName);
  } catch (error) {
    const logs = await runCommand(DOCKER_BIN, ["logs", containerName], { timeoutMs: 20_000 });
    await runCommand(DOCKER_BIN, ["rm", "-f", containerName], { timeoutMs: 20_000 }).catch(() => {});
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nDocker logs:\n${logs.stdout}\n${logs.stderr}`,
    );
  }

  return {
    database: "wordpress",
    host: "127.0.0.1",
    password: "wordpress",
    port: hostPort,
    username: "wordpress",
    cleanup: async () => {
      await runCommand(DOCKER_BIN, ["rm", "-f", containerName], { timeoutMs: 20_000 }).catch(() => {});
    },
  };
};

const loadSdkLiteModules = async () => {
  if (!sdkLiteModulesPromise) {
    sdkLiteModulesPromise = (async () => {
      await assertCommandOk("npm", ["run", "build-sdk"], {
        cwd: SDK_LITE_DIR,
        timeoutMs: 180_000,
      });

      const requireFromSdkLite = createRequire(path.join(SDK_LITE_DIR, "package.json"));
      const { Server } = requireFromSdkLite("ssh2");
      const sdkLite = await import(pathToFileURL(path.join(SDK_LITE_DIR, "dist", "index.js")).href);

      return {
        DeployAppSshUser: sdkLite.DeployAppSshUser,
        SshServer: Server,
      };
    })();
  }

  return sdkLiteModulesPromise;
};

const patchWordPressFixture = async (fixtureDir, { baseUrl, database, httpPort }) => {
  const tomlPath = path.join(fixtureDir, "wasmer.toml");
  const installPath = path.join(fixtureDir, "wasmer", "install.php");
  const configPath = path.join(fixtureDir, "wp-config.php");

  const toml = await readFile(tomlPath, "utf8");
  const installScript = await readFile(installPath, "utf8");
  const config = await readFile(configPath, "utf8");

  const patchedToml = toml.replace("localhost:8080", `127.0.0.1:${httpPort}`);
  const patchedInstall = installScript.replace("MYSQLI_CLIENT_SSL", "0");
  const patchedConfig = config
    .replace("define( 'DB_NAME', $_ENV['DB_NAME'] );", `define( 'DB_NAME', ${toPhpStringLiteral(database.database)} );`)
    .replace("define( 'DB_USER', $_ENV['DB_USERNAME'] );", `define( 'DB_USER', ${toPhpStringLiteral(database.username)} );`)
    .replace("define( 'DB_PASSWORD', $_ENV['DB_PASSWORD'] );", `define( 'DB_PASSWORD', ${toPhpStringLiteral(database.password)} );`)
    .replace(
      "define( 'DB_HOST', $_ENV['DB_HOST'] );",
      `define( 'DB_HOST', ${toPhpStringLiteral(`${database.host}:${database.port}`)} );`,
    )
    .replace("define( 'DB_PORT', $_ENV['DB_PORT'] );", `define( 'DB_PORT', ${toPhpStringLiteral(String(database.port))} );`)
    .replace("define('MYSQL_CLIENT_FLAGS', MYSQLI_CLIENT_SSL);", "define('MYSQL_CLIENT_FLAGS', 0);")
    .replace(
      `define( 'WP_HOME',  isset($_SERVER['HTTP_HOST']) ? ($scheme . $_SERVER['HTTP_HOST'] ): "http://localhost");`,
      `define( 'WP_HOME', ${toPhpStringLiteral(baseUrl)} );`,
    )
    .replace("define( 'WP_DEBUG', true );", "define( 'WP_DEBUG', false );");

  await writeFile(tomlPath, patchedToml);
  await writeFile(installPath, patchedInstall);
  await writeFile(configPath, patchedConfig);
};

const prepareFixture = async ({ baseUrl, database, httpPort }) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sdk-wordpress-"));
  const webcPath = path.join(rootDir, "wordpress.webc");

  await assertCommandOk(
    WASMER_BIN,
    ["package", "download", "--quiet", "--unpack", "--out-path", webcPath, WORDPRESS_PACKAGE],
    { timeoutMs: 180_000 },
  );

  const packageParts = WORDPRESS_PACKAGE.split("/");
  const packageName = packageParts[packageParts.length - 1] ?? "wordpress";
  const fixtureCandidates = [
    `${webcPath}.unpacked`,
    path.join(rootDir, packageName),
  ];
  const fixtureDir = fixtureCandidates.find((candidate) => existsSync(path.join(candidate, "wasmer.toml")));

  assert.ok(fixtureDir, `Could not find an unpacked WordPress fixture in ${rootDir}`);
  await patchWordPressFixture(fixtureDir, { baseUrl, database, httpPort });
  return { fixtureDir, rootDir };
};

const createBaseEnv = (database, baseUrl) => ({
  DB_HOST: database.host,
  DB_NAME: database.database,
  DB_PASSWORD: database.password,
  DB_PORT: String(database.port),
  DB_USERNAME: database.username,
  WP_INSTALL: "1",
  WP_INSTALL_APP_DOMAIN: baseUrl,
  WP_INSTALL_EMAIL: ADMIN_EMAIL,
  WP_INSTALL_LANGUAGE: "en_US",
  WP_INSTALL_PASSWORD: ADMIN_PASSWORD,
  WP_INSTALL_TITLE: SITE_TITLE,
  WP_INSTALL_USER: ADMIN_USERNAME,
});

const installWordPress = async (fixtureDir, env) => {
  await assertCommandOk(
    WASMER_BIN,
    ["run", "--net", ...toWasmerEnvArgs(env), "-e", "install", fixtureDir],
    { env: { ...process.env, ...env }, timeoutMs: 180_000 },
  );
};

const startWordPressServer = async (fixtureDir, env, baseUrl) => {
  const running = startProcess(
    WASMER_BIN,
    ["run", "--net", ...toWasmerEnvArgs(env), fixtureDir],
    { env: { ...process.env, ...env } },
  );

  try {
    await waitForHttp(baseUrl);
    return running;
  } catch (error) {
    await stopProcess(running).catch(() => {});
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nstdout:\n${running.stdout.join("")}\n\nstderr:\n${running.stderr.join("")}`,
    );
  }
};

const startSshServer = async ({ fixtureDir, password, rootDir, username }) => {
  const { SshServer } = await loadSdkLiteModules();
  const hostKeyPath = path.join(rootDir, "ssh_host_ed25519_key");
  const hostKeyPubPath = `${hostKeyPath}.pub`;
  const port = await getFreePort();

  await assertCommandOk("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    hostKeyPath,
  ], { timeoutMs: 20_000 });

  const hostKey = await readFile(hostKeyPath);
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (context) => {
      if (
        context.method === "password"
        && context.username === username
        && context.password === password
      ) {
        context.accept();
        return;
      }

      context.reject(["password"]);
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();

        session.on("pty", (acceptPty) => {
          acceptPty();
        });

        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          const child = spawn("bash", ["-lc", info.command], {
            cwd: fixtureDir,
            env: {
              ...process.env,
              HOME: fixtureDir,
              PWD: fixtureDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });

          child.stdout?.on("data", (chunk) => {
            stream.write(chunk);
          });
          child.stderr?.on("data", (chunk) => {
            stream.stderr.write(chunk);
          });
          child.once("close", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
          stream.once("close", () => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGTERM");
            }
          });
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(hostKeyPath, { force: true }).catch(() => {});
      await rm(hostKeyPubPath, { force: true }).catch(() => {});
    },
  };
};

test("can install and serve WordPress locally with wasmer run and execute SSH commands", { timeout: 10 * 60_000 }, async () => {
  const httpPort = Number.isFinite(WORDPRESS_HTTP_PORT) ? WORDPRESS_HTTP_PORT : await getFreePort();
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const database = await getDatabaseConfig();

  let rootDir = null;
  let fixtureDir = null;
  let server = null;
  let sshServer = null;

  try {
    const fixture = await prepareFixture({ baseUrl, database, httpPort });
    fixtureDir = fixture.fixtureDir;
    rootDir = fixture.rootDir;

    const env = createBaseEnv(database, baseUrl);

    await installWordPress(fixtureDir, env);
    server = await startWordPressServer(fixtureDir, env, baseUrl);
    sshServer = await startSshServer({
      fixtureDir,
      password: SSH_PASSWORD,
      rootDir,
      username: SSH_USERNAME,
    });

    const homeResponse = await waitForHttp(`${baseUrl}/`);
    const homeText = await homeResponse.text();
    assert.match(homeText, /SDK WordPress Test/i);

    const restResponse = await waitForHttp(`${baseUrl}/?rest_route=/`);
    const restText = await restResponse.text();
    assert.match(restText, /"namespaces":/);

    const { DeployAppSshUser } = await loadSdkLiteModules();
    const sshUser = new DeployAppSshUser({
      id: "local_ssh_user",
      username: SSH_USERNAME,
      sftpRootFolder: fixtureDir,
      port: sshServer.port,
      serverHost: "127.0.0.1",
      authenticationMethods: ["PASSWORD"],
      authorizedKeys: {
        edges: [],
      },
    });

    const sshResult = await sshUser.exec(
      "pwd && test -f wp-config.php && test -d wp-content/themes/twentytwentyfour && echo ssh-ok",
      {
        password: SSH_PASSWORD,
        pty: true,
        timeoutMs: 20_000,
      },
    );
    assert.match(sshResult.stdout, /ssh-ok/);
    assert.match(sshResult.stdout, /sdk-wordpress-/);

    await assert.rejects(
      () => sshUser.exec("exit 7", { password: SSH_PASSWORD, timeoutMs: 20_000 }),
      /SSH command failed with exit code 7: exit 7/,
    );
  } finally {
    if (sshServer) {
      await sshServer.close().catch(() => {});
    }
    if (server) {
      await stopProcess(server).catch(() => {});
    }
    await database.cleanup().catch(() => {});
    if (rootDir && !KEEP_FIXTURE) {
      await rm(rootDir, { force: true, recursive: true }).catch(() => {});
    }
  }
});
