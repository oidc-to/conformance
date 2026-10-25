import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { alive, deadline, poll, request, run, step, tunnel } from "./process.mjs";

export const tag = process.env.CONFORMANCE_IMAGE_TAG || "release-v5.3.3";
// The suite's default base URL: its nginx, which resolves to 127.0.0.1 and is not published here.
const unpublished = "https://localhost.emobix.co.uk:8443";
// A project per run, named for the runner's pid so a later run can tell a crashed one's leftovers.
const projectPattern = /^oidc-conformance-(\d+)-[0-9a-f]+$/;

// A port on 127.0.0.1 that nothing is listening on.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export class Suite {
  constructor(work) {
    this.work = work;
    this.dir = join(work, "suite");
    this.venv = join(work, "venv");
    this.project = `oidc-conformance-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.public = undefined;
  }

  // The base URL the suite writes into everything it hosts and hands the OP.
  get url() {
    return this.public ?? unpublished;
  }

  // The suite's nginx on this machine, for the runner. The suite refuses plain http that no proxy
  // marked as https; localhost.emobix.co.uk resolves to 127.0.0.1, under a self-signed certificate.
  get api() {
    return `https://localhost.emobix.co.uk:${this.ports.nginx}`;
  }

  // Projects of runs whose runner is gone.
  async removeLeftovers() {
    const projects = JSON.parse(
      execFileSync("docker", ["compose", "ls", "-a", "--format", "json"], { encoding: "utf8" }) || "[]",
    );
    for (const { Name } of projects) {
      const pid = Number(Name.match(projectPattern)?.[1]);
      if (!pid || alive(pid)) continue;
      step(`Removing ${Name}, left by a run that is gone…`);
      await run("docker", ["compose", "-p", Name, "down", "-v"]).catch(() => {});
    }
  }

  async download() {
    // run-test-plan.py loads client certificates from here and fails if it is missing.
    mkdirSync(join(this.dir, "certs-keys"), { recursive: true });
    step(`Downloading suite ${tag}…`);
    const raw = `https://gitlab.com/openid/conformance-suite/-/raw/${tag}`;
    const files = {
      "docker-compose-prebuilt.yml": `${raw}/docker-compose-prebuilt.yml`,
      "run-test-plan.py": `${raw}/scripts/run-test-plan.py`,
      "conformance.py": `${raw}/scripts/conformance.py`,
      "test_plan_parser.py": `${raw}/scripts/test_plan_parser.py`,
      "requirements.txt": `${raw}/scripts/requirements.txt`,
    };
    for (const [name, url] of Object.entries(files)) {
      await run("curl", ["-fsSLo", join(this.dir, name), url]);
    }
    step("Installing runner requirements…");
    if (!existsSync(this.venv)) await run("python3", ["-m", "venv", this.venv]);
    await run(join(this.venv, "bin/pip"), [
      "install",
      "-q",
      "--disable-pip-version-check",
      "-r",
      join(this.dir, "requirements.txt"),
    ]);
  }

  // Starts the suite. With publish, it is on a public https address first, so the OP can fetch
  // the request_uri, sector_identifier_uri and jwks_uri documents it hosts.
  async start({ publish }) {
    await this.download();
    await this.removeLeftovers();
    this.ports = { server: await freePort(), nginx: await freePort() };
    if (publish) {
      step("Opening the suite's tunnel…");
      // To the server itself: the tunnel marks its requests as https.
      const origin = `http://localhost:${this.ports.server}`;
      ({ origin: this.public } = await deadline(tunnel(origin), "the suite's tunnel", 120));
      step(`Suite tunnel: ${this.public}`);
    }
    const override = [
      "services:",
      // Mongo's bind-mounted data dir fails to reopen on macOS; each run starts empty.
      "  mongodb:",
      "    volumes: !reset []",
      // Fixed host ports would collide with another run's.
      "  nginx:",
      "    ports: !override",
      `      - "127.0.0.1:${this.ports.nginx}:8443"`,
      "  server:",
      "    ports:",
      `      - "127.0.0.1:${this.ports.server}:8080"`,
    ];
    writeFileSync(join(this.dir, "compose.override.yml"), `${override.join("\n")}\n`);
    step(`Starting the suite (docker compose -p ${this.project})…`);
    this.started = true;
    await this.compose("up", "-d");
    step("Waiting for the suite…");
    await poll("the conformance suite", 300, async () => this.status("runner/available") === "200");
    if (publish) {
      await poll("the conformance suite through its tunnel", 120, async () => {
        const res = await request(`${this.public}/api/runner/available`);
        return res.ok;
      });
    }
    step("Suite ready");
  }

  async stop() {
    if (!this.started) return;
    step("Stopping the suite…");
    return this.compose("down", "-v");
  }

  compose(...args) {
    return run(
      "docker",
      [
        "compose",
        "-p",
        this.project,
        ...["docker-compose-prebuilt.yml", "compose.override.yml"].flatMap((file) => ["-f", join(this.dir, file)]),
        ...args,
      ],
      { env: { ...process.env, IMAGE_TAG: tag, BASE_URL: this.url } },
    );
  }

  status(path) {
    return execFileSync("curl", ["-sko", "/dev/null", "-w", "%{http_code}", `${this.api}/api/${path}`], {
      encoding: "utf8",
    });
  }

  get(path) {
    return JSON.parse(execFileSync("curl", ["-skf", `${this.api}/api/${path}`], { encoding: "utf8" }));
  }

  post(path, body, type = "application/json") {
    const args = ["-skf", "-X", "POST", `${this.api}/api/${path}`];
    if (body) args.push("-H", `Content-Type: ${type}`, "--data-binary", "@-");
    return JSON.parse(execFileSync("curl", args, { encoding: "utf8", input: body }));
  }
}
