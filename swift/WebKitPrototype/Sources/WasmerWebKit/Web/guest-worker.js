import "./node-compat.js";
import "./memory-budget.js";
import "./sdk/dist/browser-worker.js";
import { installDiagnostics } from "./diagnostics.js";

installDiagnostics();
