import { init, Wasmer } from "@wasmer/sdk-lite";
// import { init, Wasmer } from "../../dist/index.js";

const WASMER_TOKEN = process.env.WASMER_TOKEN;

await init({
    registryUrl: "https://registry.wasmer.io/graphql",
    token: WASMER_TOKEN
});

// const app = await Wasmer.getApp({
//     owner: "theowner",
//     name: "appname"
// });

const app = await Wasmer.getApp({
    id: "da_XYZ"
});

console.log("App", app);
console.log("SSH users", app?.sshServer?.users ?? []);
