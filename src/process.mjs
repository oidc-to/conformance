import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);

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

// Process groups to SIGINT on teardown.
export const children = [];

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
    child.on("close", (code) => reject(new Error(`${[command, ...args].join(" ")} exited ${code}`)));
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
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {}
  }
}
