import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engine = resolve(root, "optimization-engine");
const windowsPython = resolve(root, ".venv", "Scripts", "python.exe");
const unixPython = resolve(root, ".venv", "bin", "python");
const python = process.env.PYTHON_BIN || (existsSync(windowsPython) ? windowsPython : existsSync(unixPython) ? unixPython : "python");
const optimizerEnvironment = {
  ...process.env,
  OSRM_BASE_URL: process.env.OSRM_BASE_URL?.trim() || "https://router.project-osrm.org",
};
const server = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", process.env.OPTIMIZER_PORT || "8000", "--reload"], {
  cwd: engine,
  stdio: "inherit",
  env: optimizerEnvironment,
});

server.on("error", (error) => {
  console.error(`Unable to start optimizer with ${python}: ${error.message}`);
  process.exitCode = 1;
});
server.on("exit", (code) => { process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));