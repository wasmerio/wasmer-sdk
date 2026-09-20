import "./node-compat.js";
import { configureGuestMemory } from "./memory-budget.js";
import "./sdk/dist/browser-worker.js";
import { installDiagnostics } from "./diagnostics.js";

configureGuestMemory(location.href);
installDiagnostics();
