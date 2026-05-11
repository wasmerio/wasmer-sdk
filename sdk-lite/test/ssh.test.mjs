import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  __setSsh2ModuleLoaderForTests,
  DeployAppSshUser,
} from "../dist/index.js";

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

const createUser = () => new DeployAppSshUser({
  id: "ssh_user_1",
  username: "wasmer",
  sftpRootFolder: "/app",
  port: 2222,
  serverHost: "example.wasmer.app",
  authenticationMethods: ["PASSWORD"],
  authorizedKeys: {
    edges: [],
  },
});

const createSsh2Module = ({
  onConnect,
  onExec,
} = {}) => {
  const instances = [];

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.connectOptions = null;
      this.execCalls = [];
      this.destroyCalled = false;
      this.endCalled = false;
      instances.push(this);
    }

    connect(options) {
      this.connectOptions = options;
      if (onConnect) {
        onConnect(this);
      }
      return this;
    }

    exec(command, options, callback) {
      this.execCalls.push({ command, options });
      if (onExec) {
        onExec(this, command, options, callback);
      }
      return this;
    }

    destroy() {
      this.destroyCalled = true;
      return this;
    }

    end() {
      this.endCalled = true;
      return this;
    }
  }

  return {
    instances,
    module: { Client: FakeClient },
  };
};

test.afterEach(() => {
  __setSsh2ModuleLoaderForTests(null);
});

test("exec streams stdout/stderr and uses the provided password", async () => {
  const ssh2 = createSsh2Module({
    onConnect(client) {
      queueMicrotask(() => client.emit("ready"));
    },
    onExec(_client, _command, _options, callback) {
      const stream = new FakeStream();
      callback(null, stream);
      queueMicrotask(() => {
        stream.emit("data", "hello ");
        stream.emit("data", new TextEncoder().encode("world"));
        stream.stderr.emit("data", new TextEncoder().encode("warn"));
        stream.emit("close", 0, null);
      });
    },
  });
  __setSsh2ModuleLoaderForTests(async () => ssh2.module);

  const user = createUser();
  const result = await user.exec("echo hello", { password: "secret" });
  const [client] = ssh2.instances;

  assert.deepEqual(result, {
    code: 0,
    command: "echo hello",
    signal: null,
    stderr: "warn",
    stdout: "hello world",
  });
  assert.equal(client.execCalls[0].options.pty, false);
  assert.deepEqual(client.connectOptions, {
    host: "example.wasmer.app",
    keepaliveInterval: 5_000,
    password: "secret",
    port: 2222,
    readyTimeout: 20_000,
    tryKeyboard: false,
    username: "wasmer",
  });
  assert.equal(client.endCalled, true);
});

test("exec rejects on non-zero exit codes by default and exposes the command result", async () => {
  const ssh2 = createSsh2Module({
    onConnect(client) {
      queueMicrotask(() => client.emit("ready"));
    },
    onExec(_client, _command, _options, callback) {
      const stream = new FakeStream();
      callback(null, stream);
      queueMicrotask(() => {
        stream.stderr.emit("data", "permission denied");
        stream.emit("close", 23, null);
      });
    },
  });
  __setSsh2ModuleLoaderForTests(async () => ssh2.module);

  const user = createUser();

  await assert.rejects(
    () => user.exec("whoami", { password: "secret" }),
    (error) => {
      assert.match(error.message, /SSH command failed with exit code 23: whoami/);
      assert.deepEqual(error.result, {
        code: 23,
        command: "whoami",
        signal: null,
        stderr: "permission denied",
        stdout: "",
      });
      return true;
    },
  );
  assert.equal(ssh2.instances[0].endCalled, true);
});

test("exec returns non-zero exit codes when check is disabled", async () => {
  const ssh2 = createSsh2Module({
    onConnect(client) {
      queueMicrotask(() => client.emit("ready"));
    },
    onExec(_client, _command, _options, callback) {
      const stream = new FakeStream();
      callback(null, stream);
      queueMicrotask(() => {
        stream.stderr.emit("data", "permission denied");
        stream.emit("close", 23, "SIGTERM");
      });
    },
  });
  __setSsh2ModuleLoaderForTests(async () => ssh2.module);

  const user = createUser();
  const result = await user.exec("whoami", {
    check: false,
    password: "secret",
    pty: true,
  });

  assert.deepEqual(result, {
    code: 23,
    command: "whoami",
    signal: "SIGTERM",
    stderr: "permission denied",
    stdout: "",
  });
  assert.equal(ssh2.instances[0].execCalls[0].options.pty, true);
});

test("exec times out and destroys the ssh client", async () => {
  const ssh2 = createSsh2Module();
  __setSsh2ModuleLoaderForTests(async () => ssh2.module);

  const user = createUser();

  await assert.rejects(
    () => user.exec("sleep 10", { password: "secret", timeoutMs: 10 }),
    /SSH command timed out after 10ms: sleep 10/,
  );
  assert.equal(ssh2.instances[0].destroyCalled, true);
  assert.equal(ssh2.instances[0].endCalled, true);
  assert.equal(ssh2.instances[0].connectOptions.readyTimeout, 10);
});
