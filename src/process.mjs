import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);

export const userAgent = `oidc-conformance/${require("../package.json").version} (+https://github.com/oidc-to/conformance)`;

const throttled = [429, 503];

// Seconds to wait from a Retry-After of seconds or an HTTP date.
function retryAfter(header) {
  if (!header) return;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(seconds, 0);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max((date - Date.now()) / 1000, 0);
}

// fetch, naming this runner. A throttled response is retried after its Retry-After, else with backoff.
export async function request(url, options = {}, { attempts = 6, maxWait = 60 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...options, headers: { "User-Agent": userAgent, ...options.headers } });
    if (!throttled.includes(res.status) || attempt === attempts) return res;
    const wait = Math.min(retryAfter(res.headers.get("retry-after")) ?? 2 ** attempt, maxWait);
    await res.body?.cancel();
    console.warn(`${res.status} from ${options.method ?? "GET"} ${url}; retrying in ${wait}s`);
    await sleep(wait * 1000);
  }
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} exited ${code}`)),
    );
  });
}

export async function poll(what, seconds, check) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}`);
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Rejects after seconds, saying hint once after hintAfter seconds.
export async function deadline(promise, what, seconds, { hint, hintAfter = 30 } = {}) {
  const timers = [];
  const timeout = new Promise((_, reject) => {
    if (hint) timers.push(setTimeout(() => console.warn(hint), hintAfter * 1000));
    timers.push(setTimeout(() => reject(new Error(`timed out after ${seconds}s waiting for ${what}`)), seconds * 1000));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

// One line per step of a run.
export function step(text) {
  console.log(process.stdout.isTTY ? `\x1b[1m▶ ${text}\x1b[0m` : `▶ ${text}`);
}

// Process groups to SIGINT on teardown.
export const children = [];
// Set once teardown has begun, when a child exiting is no longer a failure.
let stopping = false;

// Starts a long-running process in its own group, so teardown reaches everything it starts.
// Resolves with the origin of the first https URL it prints on stdout.
export function startAnnouncing(command, args, { shell = false, echo, env } = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell,
    env: env ?? process.env,
  });
  children.push(child);
  const exited = new Promise((_, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (!stopping) reject(new Error(`${[command, ...args].join(" ")} exited ${code ?? signal}`));
    });
  });
  // The last of what it said, for when it exits before announcing.
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    if (echo) process.stderr.write(chunk);
    else if (stderr.push(chunk) > 50) stderr.shift();
  });
  const announced = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (echo) process.stdout.write(`${line}\n`);
      const url = line.match(/https:\/\/\S+/)?.[0];
      if (url) resolve({ origin: new URL(url).origin, child });
    });
  });
  return Promise.race([announced, exited]).catch((error) => {
    if (stderr.length) process.stderr.write(Buffer.concat(stderr));
    throw error;
  });
}

// tunneld's launcher, which its package exports do not expose.
function tunneldLauncher() {
  const dir = require.resolve.paths("tunneld").find((path) => existsSync(join(path, "tunneld/package.json")));
  if (!dir) throw new Error("tunneld is not installed");
  return join(dir, "tunneld", require(join(dir, "tunneld/package.json")).bin.tunneld);
}

// A tunnel.pizza address for an http origin on this machine.
export function tunnel(origin) {
  return startAnnouncing(process.execPath, [tunneldLauncher(), "--multiview=false", origin]);
}

export function stopChildren() {
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {}
  }
}
