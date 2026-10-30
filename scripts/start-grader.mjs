// One-click start for running the grader on your own computer (Windows, macOS, Linux). "Start Grader.bat",
// start-grader.command and start-grader.sh check for Node.js, then run this file, which:
//   1. installs the packages (npm install) when node_modules is missing or package-lock.json changed;
//   2. builds the app (npm run build) when it was never built or the code changed since the last build;
//   3. creates .env.local from .env.example the first time (AI_MODE=claude, no API key: choose Ollama in Settings);
//   4. starts the app on http://localhost:3000 (PORT=… to change it), waits until it answers, and opens the browser.
// Ctrl+C (or closing the window) stops it. Uses only Node's own modules, so it runs before npm install.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 3000;
const URL_HOME = `http://localhost:${PORT}`;
const IS_WINDOWS = process.platform === "win32";
const DEPS_STAMP = path.join(ROOT, "node_modules", ".grader-deps-stamp");
const BUILD_STAMP = path.join(ROOT, ".next", ".grader-build-stamp");
const MIN_NODE = [22, 13];

function say(message = "") {
  console.log(message);
}

function fail(message) {
  console.error(`\n[!] ${message}\n`);
  process.exit(1);
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return;
  fail(`Node.js ${process.versions.node} is too old: version ${MIN_NODE.join(".")} or newer is needed.\n`
    + "    Install the LTS version from https://nodejs.org, then start the grader again.");
}

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file);
  } catch {
    return fallback;
  }
}

/** Runs npm with the given arguments in the app folder, showing its output; exits on failure. */
function npm(args, what) {
  say(`>>> ${what} (npm ${args.join(" ")}) - this can take a few minutes the first time...`);
  // npm is npm.cmd on Windows, which Node only starts through the shell.
  const result = spawnSync(IS_WINDOWS ? "npm.cmd" : "npm", args, { cwd: ROOT, stdio: "inherit", shell: IS_WINDOWS });
  if (result.status !== 0) fail(`"npm ${args.join(" ")}" failed. Check your internet connection and try again.`);
}

/** The packages to install are named by package-lock.json. */
function depsStamp() {
  return sha256(readOr(path.join(ROOT, "package-lock.json"), ""), process.versions.node.split(".")[0], process.platform, process.arch);
}

function ensureDependencies() {
  const stamp = depsStamp();
  const installed = fs.existsSync(path.join(ROOT, "node_modules", "next")) && readOr(DEPS_STAMP, "").toString() === stamp;
  if (installed) return;
  npm(["install", "--no-audit", "--no-fund"], "Installing the packages");
  fs.writeFileSync(DEPS_STAMP, stamp);
}

/** Every file the build reads, by name, size and time: any change (an update, an edit) means building again. */
function sourceStamp() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", shell: false });
  const parts = [head.status === 0 ? head.stdout.trim() : "no-git"];
  const files = ["package.json", "package-lock.json", "next.config.ts", "postcss.config.mjs", "tsconfig.json"];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk("src");
  for (const rel of files.sort()) {
    const stat = fs.statSync(path.join(ROOT, rel), { throwIfNoEntry: false });
    if (stat) parts.push(`${rel}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
  }
  return sha256(...parts);
}

function ensureBuild() {
  const stamp = sourceStamp();
  const built = fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) && readOr(BUILD_STAMP, "").toString() === stamp;
  if (built) return;
  npm(["run", "build"], "Building the app");
  fs.writeFileSync(BUILD_STAMP, stamp);
}

function ensureEnvFile() {
  const envLocal = path.join(ROOT, ".env.local");
  if (fs.existsSync(envLocal)) return;
  const example = readOr(path.join(ROOT, ".env.example"), "").toString();
  // Real grading (AI_MODE=claude) without an API key: choose "On this computer (Ollama)" in Settings, or add a key there.
  const text = example
    .replace(/^AI_MODE=.*$/m, "AI_MODE=claude")
    .replace(/^ANTHROPIC_API_KEY=.*$/m, "ANTHROPIC_API_KEY=");
  fs.writeFileSync(envLocal, text.includes("AI_MODE=") ? text : `${text}\nAI_MODE=claude\n`);
  say(">>> Created .env.local (settings for this computer).");
}

async function answers() {
  try {
    const res = await fetch(`${URL_HOME}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  say(`>>> Opening ${URL_HOME} in your browser.`);
  if (IS_WINDOWS) spawn("cmd", ["/c", "start", "", URL_HOME], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [URL_HOME], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function main() {
  process.chdir(ROOT);
  say("=====================================================");
  say("  DragonGrader - starting on this computer");
  say("=====================================================");
  checkNode();
  if (await answers()) {
    say(`The grader is already running at ${URL_HOME}.`);
    openBrowser();
    return;
  }
  ensureDependencies();
  ensureEnvFile();
  ensureBuild();

  say(`>>> Starting the grader at ${URL_HOME} ...`);
  // The same as "npm start", on the chosen port.
  const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "--port", String(PORT)], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" },
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    say("\n>>> Stopping the grader...");
    server.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => {
    if (!stopping && code !== 0) {
      fail(`The grader stopped unexpectedly (exit code ${code}). If another program uses port ${PORT}, close it or set PORT.`);
    }
    process.exit(0);
  });

  for (let waited = 0; waited < 120; waited++) {
    if (await answers()) {
      say("");
      say("=====================================================");
      say(`  The grader is running:  ${URL_HOME}`);
      say("  Keep this window open while you grade.");
      say("  Press Ctrl+C (or close this window) to stop it.");
      say("=====================================================");
      openBrowser();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  say(`The grader hasn't answered yet; open ${URL_HOME} in your browser in a moment.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
