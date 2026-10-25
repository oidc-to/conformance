import assert from "node:assert/strict";
import { test } from "node:test";
import { Clients, suiteConfig } from "../src/config.mjs";
import { parseArgs, resolveTarget, targetOf, UsageError } from "../src/main.mjs";
import { combinations, formatVariant, matchingVariants, parseVariant, planName } from "../src/plans.mjs";
import { children, request, startAnnouncing, userAgent } from "../src/process.mjs";
import { merge, summarize } from "../src/summary.mjs";

test("options come before the target, which keeps its own flags", () => {
  assert.deepEqual(parseArgs(["--plan", "p", "npm", "run", "dev", "--", "--port", "1"]), {
    plan: "p",
    target: ["npm", "run", "dev", "--", "--port", "1"],
  });
  assert.deepEqual(parseArgs(["--variant=a=b", "https://op.example"]), {
    variant: "a=b",
    target: ["https://op.example"],
  });
  assert.deepEqual(parseArgs(["variants", "--plan", "p"]), { command: "variants", plan: "p", target: [] });
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("a lone URL is an issuer, anything else a command", () => {
  assert.deepEqual(targetOf(["https://op.example/"]), { issuer: "https://op.example" });
  assert.deepEqual(targetOf(["https://op.example/tenant"]), { issuer: "https://op.example/tenant" });
  assert.deepEqual(targetOf(["npm", "run", "dev"]), { command: ["npm", "run", "dev"] });
});

const plan = {
  variants: {
    client_auth_type: { variantValues: { none: {}, private_key_jwt: {}, tls_client_auth: {} } },
    response_type: { variantValues: { code: {}, "code id_token": {} } },
  },
};

test("variants expand without mTLS and filter by axis=value", () => {
  assert.equal(combinations({ a: [1, 2], b: [3, 4] }).length, 4);
  assert.equal(matchingVariants(plan, {}).length, 4);
  const filtered = matchingVariants(plan, parseVariant("response_type=code id_token"));
  assert.deepEqual(filtered.map(formatVariant), [
    "client_auth_type=none,response_type=code id_token",
    "client_auth_type=private_key_jwt,response_type=code id_token",
  ]);
  assert.equal(planName("p", { a: "b" }, "m1,m2"), "p[a=b]:m1,m2");
});

const module = (testModule, result, conditions = []) => ({ testModule, result, conditions, shots: [] });

test("runs are labelled by the axes that vary, and merged runs read as one table", () => {
  const one = {
    name: "p",
    tag: "t",
    runs: [{ variant: { a: "x", b: "y" }, modules: [module("m1", "PASSED")] }],
  };
  const two = {
    name: "p",
    tag: "t",
    runs: [
      {
        variant: { a: "z", b: "y" },
        modules: [module("m1", "FAILED", [{ level: "FAILURE", src: "Check", msg: "bad" }])],
      },
    ],
  };
  const summary = summarize({ ...one, runs: [...one.runs, ...two.runs] });
  assert.deepEqual(summary.tables[0].header, ["module", "x", "z"]);
  assert.deepEqual(summary.tables[0].rows, [["m1", "✅", "❌"]]);
  assert.equal(summary.tables[0].note, "every run at y");
  assert.equal(summary.reasons[0].conditions[0].where, "z");
  assert.equal(summarize(one).tables[0].header[1], "x · y");
});

test("merge rebases screenshot paths onto the output directory", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "merge-"));
  mkdirSync(join(root, "job-1"));
  const shot = { src: "s", msg: "m", file: "screenshots/v/m1-s.png" };
  writeFileSync(
    join(root, "job-1", "summary.json"),
    JSON.stringify({ name: "p", tag: "t", runs: [{ variant: {}, modules: [{ ...module("m1", "REVIEW"), shots: [shot] }] }] }),
  );
  const data = merge([join(root, "job-1", "summary.json")], join(root, "out"));
  assert.equal(data.runs[0].modules[0].shots[0].file, "../job-1/screenshots/v/m1-s.png");
});

test("a started command's issuer is the first https origin it prints", async () => {
  const script = `console.log("> app dev"); console.log("https://0tabc.example.test/?0"); setInterval(() => {}, 1000);`;
  const { origin, child } = await startAnnouncing(process.execPath, ["-e", script], { echo: false });
  assert.equal(origin, "https://0tabc.example.test");
  process.kill(-child.pid, "SIGINT");
  children.length = 0;
});

test("a command that exits before printing an origin fails", async () => {
  await assert.rejects(startAnnouncing(process.execPath, ["-e", "process.exit(3)"]), /exited 3/);
  children.length = 0;
});

test("the suite config takes clients, browser tasks and overrides from the config", async () => {
  const seen = [];
  const config = {
    alias: "op",
    client: ({ name, method, secret, key, callback }) => {
      seen.push([name, method, secret]);
      assert.equal(key.kid, name);
      return { client_id: `${name}:${method}`, redirect: callback };
    },
    browser: ({ placeholder }) => [{ match: "x", placeholder }],
    override: { m: {} },
  };
  const discovery = { issuer: "https://op.example", jwks_uri: "https://op.example/jwks" };
  const result = await suiteConfig({
    config,
    clients: new Clients(),
    issuer: "https://op.example",
    suite: "https://suite.example",
    discovery,
    variant: { client_auth_type: "private_key_jwt", server_metadata: "static" },
    rendering: false,
  });
  assert.deepEqual(seen, [
    ["client", "private_key_jwt", false],
    ["client2", "private_key_jwt", false],
    ["client", "client_secret_post", true],
  ]);
  assert.equal(result.client.redirect, "https://suite.example/test/a/op/callback");
  assert.deepEqual(result.browser[0].placeholder, ["update-image-placeholder-optional"]);
  assert.equal(result.server.jwks_uri, "https://op.example/jwks");
  assert.deepEqual(result.override, { m: {} });
});

test("deadline hints once, then gives up", async () => {
  const { deadline } = await import("../src/process.mjs");
  const warnings = [];
  const warn = console.warn;
  console.warn = (text) => warnings.push(text);
  try {
    await assert.rejects(
      deadline(new Promise(() => {}), "an origin", 0.2, { hint: "no origin yet", hintAfter: 0.05 }),
      /timed out after 0.2s waiting for an origin/,
    );
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, ["no origin yet"]);
  assert.equal(await deadline(Promise.resolve(1), "x", 1), 1);
});

test("requests name the runner and its version", async () => {
  const { createServer } = await import("node:http");
  const version = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url))).version;
  assert.equal(userAgent, `oidc-conformance/${version} (+https://github.com/oidc-to/conformance)`);
  const server = createServer((req, res) => res.end(req.headers["user-agent"]));
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await request(`http://127.0.0.1:${server.address().port}/`, { headers: { Accept: "text/plain" } });
    assert.equal(await res.text(), userAgent);
  } finally {
    server.close();
  }
});

test("throttled requests are retried after Retry-After, then given up on", async () => {
  const { createServer } = await import("node:http");
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url === "/once" && calls > 1) return res.end("ok");
    res.writeHead(calls % 2 ? 429 : 503, { "Retry-After": "0" }).end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await request(`${base}/once`, { method: "POST", body: "{}" });
    assert.equal(await res.text(), "ok");
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await request(`${base}/always`, {}, { attempts: 3 })).status, 429);
    assert.equal(calls, 3);
  } finally {
    console.warn = warn;
    server.close();
  }
});

test("the config's command is the target only when the command line gives none", async () => {
  const remotes = [];
  const loaded = ({ remote }) => (remotes.push(remote), { command: "npm run dev", rotateKeys: remote ? undefined : () => {} });
  assert.deepEqual((await resolveTarget([], loaded)).target, { command: ["npm run dev"] });
  assert.ok((await resolveTarget([], loaded)).config.rotateKeys);
  assert.deepEqual((await resolveTarget(["https://op.example"], loaded)).target, { issuer: "https://op.example" });
  assert.deepEqual((await resolveTarget(["next", "dev"], loaded)).target, { command: ["next", "dev"] });
  assert.deepEqual(remotes, [false, false, true, false]);
  assert.deepEqual((await resolveTarget([], { command: ["npm", "run", "dev"] })).target, { command: ["npm", "run", "dev"] });
  await assert.rejects(resolveTarget([], {}), UsageError);
});
