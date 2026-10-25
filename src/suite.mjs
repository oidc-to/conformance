import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poll, run, tunnel } from "./process.mjs";

export const tag = process.env.CONFORMANCE_IMAGE_TAG || "release-v5.3.3";
const project = "oidc-to-conformance";
// The suite's nginx, under a self-signed certificate; localhost.emobix.co.uk resolves to 127.0.0.1.
export const local = "https://localhost.emobix.co.uk:8443";
// The suite's server, published on this machine for the tunnel: plain http, no nginx in front.
const httpPort = 8480;

export class Suite {
  constructor(work) {
    this.work = work;
    this.dir = join(work, "suite");
    this.venv = join(work, "venv");
    this.public = undefined;
  }

  // The base URL the suite writes into everything it hosts and hands the OP.
  get url() {
    return this.public ?? local;
  }

  async download() {
    // run-test-plan.py loads client certificates from here and fails if it is missing.
    mkdirSync(join(this.dir, "certs-keys"), { recursive: true });
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
    // Mongo's bind-mounted data dir fails to reopen on macOS; each run starts empty.
    const override = ["services:", "  mongodb:", "    volumes: !reset []"];
    if (publish) {
      ({ origin: this.public } = await tunnel(`http://localhost:${httpPort}`));
      console.log(`suite ${this.public}`);
      override.push("  server:", "    ports:", `      - "127.0.0.1:${httpPort}:8080"`);
    }
    writeFileSync(join(this.dir, "compose.override.yml"), `${override.join("\n")}\n`);
    await this.compose("up", "-d");
    await poll("the conformance suite", 300, async () => this.status("runner/available") === "200");
    if (publish) {
      await poll("the conformance suite through its tunnel", 120, async () => {
        const res = await fetch(`${this.public}/api/runner/available`);
        return res.ok;
      });
    }
  }

  stop() {
    return this.compose("down", "-v");
  }

  compose(...args) {
    return run(
      "docker",
      [
        "compose",
        "-p",
        project,
        ...["docker-compose-prebuilt.yml", "compose.override.yml"].flatMap((file) => ["-f", join(this.dir, file)]),
        ...args,
      ],
      { env: { ...process.env, IMAGE_TAG: tag, BASE_URL: this.url } },
    );
  }

  status(path) {
    return execFileSync("curl", ["-sko", "/dev/null", "-w", "%{http_code}", `${local}/api/${path}`], {
      encoding: "utf8",
    });
  }

  get(path) {
    return JSON.parse(execFileSync("curl", ["-skf", `${local}/api/${path}`], { encoding: "utf8" }));
  }

  post(path, body, type = "application/json") {
    const args = ["-skf", "-X", "POST", `${local}/api/${path}`];
    if (body) args.push("-H", `Content-Type: ${type}`, "--data-binary", "@-");
    return JSON.parse(execFileSync("curl", args, { encoding: "utf8", input: body }));
  }
}
