import { srcAutobuildMutation, srcAutobuildMutation$variables } from './__generated__/srcAutobuildMutation.graphql';
import { createEnvironment } from './environment';
import RelayRuntime, { ReaderFragment, type Environment, type MutationParameters } from 'relay-runtime';
import { srcAutobuildSubscription } from './__generated__/srcAutobuildSubscription.graphql';
import nodeApp, { srcDeployAppData$data } from './__generated__/srcDeployAppData.graphql';
import nodeSshAuthorizedKey, { srcDeployAppSshAuthorizedKeyData$data } from './__generated__/srcDeployAppSshAuthorizedKeyData.graphql';
import nodeSshServer, { srcDeployAppSshServerData$data } from './__generated__/srcDeployAppSshServerData.graphql';
import nodeSshUser, { srcDeployAppSshUserData$data } from './__generated__/srcDeployAppSshUserData.graphql';
import nodeAppVersion, { srcDeployAppVersionData$data, srcDeployAppVersionData$key } from './__generated__/srcDeployAppVersionData.graphql';
import nodeDeployAppKindWordPress, { srcDeployAppKindWordPress$data, srcDeployAppKindWordPress$key } from './__generated__/srcDeployAppKindWordPress.graphql';
import { srcAddSshAuthorizedKeyMutation } from './__generated__/srcAddSshAuthorizedKeyMutation.graphql';
import { srcDeleteAppMutation, srcDeleteAppMutation$variables } from './__generated__/srcDeleteAppMutation.graphql';
import { srcGenerateSshTokenMutation } from './__generated__/srcGenerateSshTokenMutation.graphql';
import { srcGetAppByNameQuery, srcGetAppByNameQuery$variables } from './__generated__/srcGetAppByNameQuery.graphql';
import { srcGetAppByIdQuery, srcGetAppByIdQuery$variables } from './__generated__/srcGetAppByIdQuery.graphql';
import { srcRevealSshUserPasswordMutation } from './__generated__/srcRevealSshUserPasswordMutation.graphql';
import { srcRotateSshUserPasswordMutation } from './__generated__/srcRotateSshUserPasswordMutation.graphql';
import { srcToggleSshServerMutation } from './__generated__/srcToggleSshServerMutation.graphql';
const { graphql, fetchQuery, commitMutation, requestSubscription, getSelector } = RelayRuntime;

export type WasmerRegistryConfig = {
  registryUrl?: string;
  token?: string;
};

export type SshAuthenticationMethod =
  | "PASSWORD"
  | "PUBLIC_KEY"
  | "%future added value";

export type AddSshAuthorizedKeyInput = {
  name?: string | null;
  publicKey: string;
};

export type SshCommandOptions = {
  check?: boolean;
  password?: string;
  pty?: boolean;
  timeoutMs?: number;
};

export type SshCommandResult = {
  code: number | null;
  command: string;
  signal: string | null;
  stderr: string;
  stdout: string;
};

let config: {
  environment: Environment;
} | null = null;

const assertConfig = () => {
  if (!config) {
    throw new Error("Wasmer is not initialized. Please call init() first.");
  }
}

const environment = () => {
  assertConfig();
  return config!.environment;
}

const isNodeRuntime = () => {
  const processRef = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!processRef?.versions?.node;
}

const decodeOutputChunk = (chunk: unknown): string => {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk);
  }
  return String(chunk);
}

const loadSsh2 = async (): Promise<any> => {
  if (!isNodeRuntime()) {
    throw new Error("SSH command execution is only available in Node.js.");
  }
  return import("ssh2");
}

class DeployAppSshAuthorizedKey {
  static fragment = graphql`
    fragment srcDeployAppSshAuthorizedKeyData on SshAuthorizedKey {
      id
      createdAt
      name
      publicKey
    }
  `
  id!: string;
  createdAt!: Date;
  name?: string | null;
  publicKey!: string;

  constructor(data: srcDeployAppSshAuthorizedKeyData$data) {
    this.applyData(data);
  }

  private applyData(data: srcDeployAppSshAuthorizedKeyData$data) {
    this.id = data.id;
    this.createdAt = new Date(data.createdAt);
    this.name = data.name;
    this.publicKey = data.publicKey;
  }
}

class DeployAppSshUser {
  static fragment = graphql`
    fragment srcDeployAppSshUserData on SshUser {
      id
      username
      sftpRootFolder
      port
      serverHost
      authenticationMethods
      authorizedKeys(first: 100) {
        edges {
          node {
            ...srcDeployAppSshAuthorizedKeyData
          }
        }
      }
    }
  `
  id!: string;
  username!: string;
  sftpRootFolder!: string;
  port!: number;
  serverHost!: string;
  authenticationMethods!: SshAuthenticationMethod[];
  authorizedKeys!: DeployAppSshAuthorizedKey[];
  private password: string | null = null;

  constructor(data: srcDeployAppSshUserData$data) {
    this.applyData(data);
  }

  private applyData(data: srcDeployAppSshUserData$data) {
    this.id = data.id;
    this.username = data.username;
    this.sftpRootFolder = data.sftpRootFolder;
    this.port = data.port;
    this.serverHost = data.serverHost;
    this.authenticationMethods = (data.authenticationMethods ?? []).filter(
      (method): method is SshAuthenticationMethod =>
        method !== null && method !== undefined,
    );
    this.authorizedKeys = data.authorizedKeys.edges
      .map((edge) => edge?.node)
      .filter((node) => node !== null && node !== undefined)
      .map((node) =>
        new DeployAppSshAuthorizedKey(
          getFragmentData<srcDeployAppSshAuthorizedKeyData$data>(
            environment(),
            nodeSshAuthorizedKey,
            node,
          ),
        ),
      );
  }

  async revealPassword(): Promise<string | null> {
    const response = await commitMutationAsync<srcRevealSshUserPasswordMutation>(
      graphql`
        mutation srcRevealSshUserPasswordMutation($input: RevealSshUserPasswordInput!) {
          revealSshUserPassword(input: $input) {
            password
            sshUser {
              ...srcDeployAppSshUserData
            }
          }
        }
      `,
      { input: { sshUserId: this.id } },
      "The SSH user password could not be revealed",
    );

    const sshUserData = getFragmentData<srcDeployAppSshUserData$data>(
      environment(),
      nodeSshUser,
      response.revealSshUserPassword!.sshUser,
    );
    this.applyData(sshUserData);
    this.password = response.revealSshUserPassword?.password ?? null;

    return this.password;
  }

  async rotatePassword(): Promise<string> {
    const response = await commitMutationAsync<srcRotateSshUserPasswordMutation>(
      graphql`
        mutation srcRotateSshUserPasswordMutation($input: RotateSshUserPasswordInput!) {
          rotateSshUserPassword(input: $input) {
            password
            sshUser {
              ...srcDeployAppSshUserData
            }
          }
        }
      `,
      { input: { sshUserId: this.id } },
      "The SSH user password could not be rotated",
    );

    const sshUserData = getFragmentData<srcDeployAppSshUserData$data>(
      environment(),
      nodeSshUser,
      response.rotateSshUserPassword!.sshUser,
    );
    this.applyData(sshUserData);
    this.password = response.rotateSshUserPassword!.password;

    return this.password;
  }

  async addAuthorizedKey(input: AddSshAuthorizedKeyInput): Promise<DeployAppSshAuthorizedKey> {
    const response = await commitMutationAsync<srcAddSshAuthorizedKeyMutation>(
      graphql`
        mutation srcAddSshAuthorizedKeyMutation($input: AddSshAuthorizedKeyInput!) {
          addSshAuthorizedKey(input: $input) {
            authorizedKey {
              ...srcDeployAppSshAuthorizedKeyData
            }
          }
        }
      `,
      {
        input: {
          sshUserId: this.id,
          publicKey: input.publicKey,
          name: input.name,
        },
      },
      "The SSH authorized key could not be added",
    );

    const keyData = getFragmentData<srcDeployAppSshAuthorizedKeyData$data>(
      environment(),
      nodeSshAuthorizedKey,
      response.addSshAuthorizedKey!.authorizedKey,
    );
    const key = new DeployAppSshAuthorizedKey(keyData);
    const existingIndex = this.authorizedKeys.findIndex((candidate) => candidate.id === key.id);

    if (existingIndex >= 0) {
      this.authorizedKeys[existingIndex] = key;
    } else {
      this.authorizedKeys.push(key);
    }

    return key;
  }

  private async resolvePassword(password?: string): Promise<string> {
    if (password) {
      return password;
    }
    if (this.password) {
      return this.password;
    }

    const revealedPassword = await this.revealPassword();
    if (!revealedPassword) {
      throw new Error(`The SSH user "${this.username}" does not have a password available.`);
    }

    return revealedPassword;
  }

  async exec(command: string, options: SshCommandOptions = {}): Promise<SshCommandResult> {
    const ssh2 = await loadSsh2();
    const password = await this.resolvePassword(options.password);

    return await new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: SshCommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        client.end();

        if (options.check !== false && result.code !== 0) {
          const error = new Error(
            `SSH command failed with exit code ${result.code}: ${command}\n${result.stderr || result.stdout}`,
          );
          (error as Error & { result?: SshCommandResult }).result = result;
          reject(error);
          return;
        }

        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        client.end();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          client.destroy();
          fail(new Error(`SSH command timed out after ${options.timeoutMs}ms: ${command}`));
        }, options.timeoutMs);
      }

      client
        .on("ready", () => {
          client.exec(
            command,
            { pty: options.pty ?? false },
            (error: unknown, stream: any) => {
              if (error) {
                fail(error);
                return;
              }

              stream.on("data", (chunk: unknown) => {
                stdout += decodeOutputChunk(chunk);
              });
              stream.stderr.on("data", (chunk: unknown) => {
                stderr += decodeOutputChunk(chunk);
              });
              stream.on("close", (code: number | null, signal: string | null) => {
                finish({
                  code: code ?? null,
                  command,
                  signal: signal ?? null,
                  stderr,
                  stdout,
                });
              });
            },
          );
        })
        .on("error", (error: unknown) => fail(error))
        .connect({
          host: this.serverHost,
          keepaliveInterval: 5_000,
          password,
          port: this.port,
          readyTimeout: options.timeoutMs ?? 20_000,
          tryKeyboard: false,
          username: this.username,
        });
    });
  }
}

class DeployAppSshServer {
  static fragment = graphql`
    fragment srcDeployAppSshServerData on AppSshServer {
      id
      enabled
      users(first: 100) {
        edges {
          node {
            ...srcDeployAppSshUserData
          }
        }
      }
    }
  `
  id!: string;
  enabled!: boolean;
  users!: DeployAppSshUser[];

  constructor(data: srcDeployAppSshServerData$data) {
    this.applyData(data);
  }

  applyData(data: srcDeployAppSshServerData$data) {
    this.id = data.id;
    this.enabled = data.enabled;
    this.users = data.users.edges
      .map((edge) => edge?.node)
      .filter((node) => node !== null && node !== undefined)
      .map((node) =>
        new DeployAppSshUser(
          getFragmentData<srcDeployAppSshUserData$data>(
            environment(),
            nodeSshUser,
            node,
          ),
        ),
      );
  }
}

class DeployAppKind {
  static fragment = graphql`
    fragment srcDeployAppKind on Kind {
      ...on WordpressAppKind {
        __typename
      }
    }
  `
}

class DeployAppKindWordPress extends DeployAppKind {
  static fragment = graphql`
    fragment srcDeployAppKindWordPress on Kind {
      ...on WordpressAppKind {
        adminUrl
      }
    }
  `
  adminUrl?: string;
  constructor(data: srcDeployAppKindWordPress$data) {
    super();
    this.adminUrl = data.adminUrl;
  }
}

class DeployApp {
      
  static fragment = graphql`
    fragment srcDeployAppData on DeployApp {
      id
      willPerishAt
      name
      url
      adminUrl
      domains {
        edges {
          node {
            id
            url
          }
        }
      }
      favicon
      screenshot
      sshServer {
        ...srcDeployAppSshServerData
      }
      # managed
      # kind {
      #   __typename
      #   ...srcDeployAppKind
      # }
    }
  `;
  id!: string;
  willPerishAt!: Date;
  name!: string;
  url!: string;
  adminUrl!: string;
  domains!: string[];
  favicon!: string;
  screenshot!: string;
  sshServer!: DeployAppSshServer | null;
  // managed: boolean;
  // kind: DeployAppKind | null = null;
  constructor(data: srcDeployAppData$data) {
    this.applyData(data);
    // this.managed = data.managed;
    // if (data.kind?.__typename === "WordPressAppKind") {
    //   let kindData = getFragmentData<srcDeployAppKindWordPress$data>(environment(), nodeApp, data.kind);
    //   this.kind = new DeployAppKindWordPress(kindData);
    // }
  }

  private applyData(data: srcDeployAppData$data) {
    this.id = data.id;
    this.willPerishAt = new Date(data.willPerishAt);
    this.name = data.name;
    this.url = data.url;
    this.adminUrl = data.adminUrl;
    this.domains = data.domains.edges.map((edge) => edge?.node?.url).filter((url) => url !== null) as string[];
    this.favicon = data.favicon;
    this.screenshot = data.screenshot;
    this.sshServer = data.sshServer
      ? new DeployAppSshServer(
          getFragmentData<srcDeployAppSshServerData$data>(
            environment(),
            nodeSshServer,
            data.sshServer,
          ),
        )
      : null;
  }

  async toggleSsh(enabled: boolean): Promise<DeployAppSshServer> {
    const response = await commitMutationAsync<srcToggleSshServerMutation>(
      graphql`
        mutation srcToggleSshServerMutation($input: ToggleSshServerInput!) {
          toggleSshServer(input: $input) {
            app {
              ...srcDeployAppData
            }
          }
        }
      `,
      { input: { appId: this.id, enabled } },
      `SSH could not be ${enabled ? "enabled" : "disabled"} for this app`,
    );

    const appData = getFragmentData<srcDeployAppData$data>(
      environment(),
      nodeApp,
      response.toggleSshServer!.app,
    );
    this.applyData(appData);

    if (!this.sshServer) {
      throw new Error("The app did not return an SSH server after toggling SSH.");
    }

    return this.sshServer;
  }

  async enableSsh(): Promise<DeployAppSshServer> {
    return this.toggleSsh(true);
  }

  async disableSsh(): Promise<DeployAppSshServer> {
    return this.toggleSsh(false);
  }

  async generateSshToken(): Promise<string> {
    const response = await commitMutationAsync<srcGenerateSshTokenMutation>(
      graphql`
        mutation srcGenerateSshTokenMutation($input: GenerateSshTokenInput!) {
          generateSshToken(input: $input) {
            token
          }
        }
      `,
      { input: { appId: this.id } },
      "An SSH token could not be generated for this app",
    );

    return response.generateSshToken!.token;
  }
}

class DeployAppVersion {
  static fragment = graphql`
    fragment srcDeployAppVersionData on DeployAppVersion {
      id
      app {
        ...srcDeployAppData
      }
    }
  `;
  id: string;
  app: DeployApp;
  constructor(data: srcDeployAppVersionData$data) {
    this.id = data.id;
    let appData = getFragmentData<srcDeployAppData$data>(environment(), nodeApp, data.app);
    this.app = new DeployApp(appData);
  }
}
function getFragmentData<T>(environment: Environment, node: ReaderFragment, fetchedData: any): T {
  let selector = getSelector(node, fetchedData);
  return environment.lookup(selector as any).data as any;
}

async function commitMutationAsync<T extends MutationParameters>(
  mutation: any,
  variables: Record<string, unknown>,
  errorPrefix: string,
): Promise<T["response"]> {
  const env = environment();

  return await new Promise((resolve, reject) => {
    commitMutation<T>(
      env,
      {
        mutation,
        onCompleted: (response: any, errors: readonly { message: string }[] | null | undefined) => {
          if (errors && errors.length > 0) {
            reject(new Error(`${errorPrefix}: ${errors[0].message.toString()}`));
            return;
          }
          resolve(response as T["response"]);
        },
        onError: (error: Error) => {
          reject(new Error(`${errorPrefix}: ${error.message.toString()}`));
        },
        variables,
      },
    )
  });
}

export type AutoBuildProgressData = {
  kind: string;
  message: string | undefined | null;
  datetime: string;
  stream: string | undefined | null;
}

class AutobuildApp {
  buildId: string;
  appVersion: DeployAppVersion | null = null;
  subscription: any;
  pendingLogs: AutoBuildProgressData[] = [];
  onProgress: ((data: AutoBuildProgressData) => void) | null = null;
  completedPromise: Promise<DeployAppVersion> | null = null;
  constructor(buildId: string) {
    this.buildId = buildId;
    this.completedPromise = new Promise((resolve, reject) => {
      const env = environment();
      this.subscription = requestSubscription<srcAutobuildSubscription>(env, {
        subscription: graphql`
          subscription srcAutobuildSubscription($buildId: UUID!) {
            autobuildDeployment(buildId: $buildId) {
              appVersion {
                ...srcDeployAppVersionData
              }
              kind
              datetime
              stream
              message
            }
          }
        `,
      variables: {
        buildId: this.buildId,
      },
      onNext: (data) => {
        // console.log(data);
        if (!data?.autobuildDeployment) {
          return;
        }
        const { kind, message, appVersion, datetime, stream } = data?.autobuildDeployment!;
        
        if (kind === "FAILED") {
          reject(message);
          return;
        }
        else if (kind === "COMPLETE") {
          if (appVersion !== undefined) {
            let appVersionData = getFragmentData<srcDeployAppVersionData$data>(env, nodeAppVersion, appVersion);
            this.appVersion = new DeployAppVersion(appVersionData);
            resolve(this.appVersion);
            return;
          }
          else {
            reject(new Error("Error when building the app: build finished without deployed app"));
            return;
          }
        }
        if (this.onProgress) {
          this.onProgress({kind, message, datetime, stream});
        } else {
          this.pendingLogs.push({kind, message, datetime, stream});
        }
      },
      onCompleted: () => {
        this.onProgress = null;
        this.subscription.dispose();
        if (!this.appVersion) {
          reject(new Error("Error when building the app: build finished without deployed app"));
        }
        else {
          resolve(this.appVersion);
          return;
        }
      },
      onError: (error) => {
        console.error(error);
        reject(error);
      },
    });
  });
}
  subscribeToProgress(callback: (data: AutoBuildProgressData) => void) {
    if (this.pendingLogs.length > 0) {
      for (const data of this.pendingLogs) {
        callback(data);
      }
      this.pendingLogs = [];
    }
    this.onProgress = callback;
  }
  async finish(): Promise<DeployAppVersion> {
    let app = await this.completedPromise;
    if (this.subscription) {
      this.subscription.dispose();
      this.subscription = null;
    }
    if (!app) {
      throw new Error("Error when building the app: build finished without deployed app");
    }
    return app;
  }
};

export const Wasmer = {
  getApp: async (input: srcGetAppByNameQuery$variables | srcGetAppByIdQuery$variables): Promise<DeployApp | null> => {
    const env = environment();
    if ('id' in input) {
      // We fetch by id
      let query = await fetchQuery<srcGetAppByIdQuery>(env, graphql`
        query srcGetAppByIdQuery($id: ID!) {
          app: node(id: $id) {
            __typename
            ...srcDeployAppData
          }
        }
      `, {
          id: input.id!,
      }).toPromise();
      if (!query?.app || query.app.__typename !== "DeployApp") {
        return null;
      }
      let appData = getFragmentData<srcDeployAppData$data>(environment(), nodeApp, query.app);
      return new DeployApp(appData);
    }
    else {
      // We fetch by name
      let query = await fetchQuery<srcGetAppByNameQuery>(env, graphql`
        query srcGetAppByNameQuery($name: String!, $owner: String) {
          app: getDeployApp(name: $name, owner: $owner) {
            ...srcDeployAppData
          }
        }
      `, {
        name: input.name,
        owner: input.owner,
      }).toPromise();
      if (!query?.app) {
        return null;
      }
      let appData = getFragmentData<srcDeployAppData$data>(environment(), nodeApp, query.app);
      return new DeployApp(appData);
    }
  },
  deleteApp: async (input: srcDeleteAppMutation$variables['input']): Promise<void> => {
    const env = environment();
    let success: any = await (new Promise((resolve, reject) => {
      commitMutation<srcDeleteAppMutation>(
        env,
        {mutation: graphql`
        mutation srcDeleteAppMutation($input: DeleteAppInput!) {
          deleteApp(input: $input) {
            success
          }
        }
      `,
      onCompleted: (response, errors) => {
        if (errors && errors.length > 0) {
          reject(`The app could not be deleted: ${errors[0].message.toString()}`);
          return;
        }
        resolve(response.deleteApp?.success);
      },
      onError: (error) => {
        reject(`The app could not be deleted: ${error.message.toString()}`);
      },
      variables: {
        input
      },
      })
    }));
    return success;
  },
  autobuildApp: async (input: srcAutobuildMutation$variables['input']): Promise<AutobuildApp> => {
    const env = environment();
    let query: any = await (new Promise((resolve, reject) => {
      commitMutation<srcAutobuildMutation>(
        env,
        {mutation: graphql`
        mutation srcAutobuildMutation($input: DeployViaAutobuildInput!) {
          deployViaAutobuild(input: $input) {
            success
            buildId
          }
        }
      `,
      onCompleted: (response, errors) => {
        if (errors && errors.length > 0) {
          reject(`The app could not be built: ${errors[0].message.toString()}`);
          return;
        }
        resolve(response);
      },
      onError: (error) => {
        reject(`The app could not be built: ${error.message.toString()}`);
      },
      variables: {
        input
      },
      })
    }));
    // console.log(query.deployViaAutobuild.buildId);
    const app = new AutobuildApp(query.deployViaAutobuild.buildId);
    return app;
  }
}
export const init = async (settings: WasmerRegistryConfig) => {
  const environment = createEnvironment({endpoint: settings.registryUrl || "https://registry.wasmer.wtf/graphql", token: settings.token});
  config = {
    environment
  };
}
// const fetchFn: FetchFunction = function (request, variables) {
//   return new Observable.create(source => {
//     fetch('/my-graphql-api', {
//       method: 'POST',
//       body: JSON.stringify({
//         text: request.text,
//         variables,
//       }),
//     })
//       .then(response => response.json())
//       .then(data => source.next(data));
//   });
// };

// const network = Network.create(fetchFn);
// const store = new Store(new RecordSource());
// const environment = new Environment({
//   network,
//   store,
// });
