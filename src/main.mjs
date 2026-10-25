import { outro } from "@clack/prompts";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Clients, loadConfig, writeSuiteConfig } from "./config.mjs";
import {
  Cancelled,
  chooseModules,
  choosePlan,
  chooseVariants,
  defaultPlan,
  findPlan,
  formatVariant,
  matchingVariants,
  parseVariant,
  rotateKeys,
} from "./plans.mjs";
import { deadline, poll, request, startAnnouncing, step, stopChildren } from "./process.mjs";
import { Runner, startRenderer } from "./run.mjs";
import { Suite, tag } from "./suite.mjs";
import { Collector, markdownSummary, merge, summarize, terminalSummary } from "./summary.mjs";

const usage = `Runs an OpenID Foundation conformance suite test plan, every variant of it, against an OP.

Usage:
  oidc-conformance [options] <issuer>            an OP already running at a public https issuer
  oidc-conformance [options] <command...>        a command that starts the OP and prints its https origin
  oidc-conformance [options]                     the config's command
  oidc-conformance variants [--plan] [--variant] the plan's variants, as a GitHub Actions matrix
  oidc-conformance merge [--out dir] <summary.json...>

Options:
  --config <file>        default conformance.config.mjs in the working directory
  --plan <name>          default ${defaultPlan}; CONFORMANCE_PLAN
  --variant <axis=value,...>  only the variants matching each; CONFORMANCE_VARIANT
  --modules <module,...> only these modules; CONFORMANCE_MODULES
  --issuer <url>         the issuer, for a command that does not print it
  --out <dir>            merge's output directory, default .conformance/results

With none of --plan, --variant or --modules in a terminal, it asks.
Exits 0 when every plan ran, however many modules failed.
`;

const options = ["config", "plan", "variant", "modules", "issuer", "out"];

// Options come first; the first word that is not one starts the target, which is the rest.
export function parseArgs(argv) {
  const parsed = { target: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      parsed.target = argv.slice(i + 1);
      break;
    }
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    const option = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!option) {
      parsed.target = argv.slice(i);
      break;
    }
    const [, name, inline] = option;
    if (!options.includes(name)) throw new Error(`unknown option --${name}`);
    parsed[name] = inline ?? argv[++i];
    if (parsed[name] === undefined) throw new Error(`--${name} needs a value`);
  }
  const [first] = parsed.target;
  if (first === "variants" || first === "merge") {
    const rest = parseArgs(parsed.target.slice(1));
    return { ...parsed, ...rest, command: first, target: rest.target };
  }
  return parsed;
}

export class UsageError extends Error {}

// The target from the command line, else the config's command, with the config for it.
export async function resolveTarget(words, loaded) {
  const configFor = async (remote) => (typeof loaded === "function" ? await loaded({ remote }) : loaded);
  if (words.length) {
    const target = targetOf(words);
    return { target, config: await configFor(Boolean(target.issuer)) };
  }
  const config = await configFor(false);
  if (!config.command) throw new UsageError("give an issuer or a command, or set command in the config");
  return { target: { command: [config.command].flat() }, config };
}

// An issuer is a lone URL; anything else is a command.
export function targetOf(words) {
  if (words.length === 1 && /^https?:\/\//.test(words[0])) {
    return { issuer: new URL(words[0]).href.replace(/\/$/, "") };
  }
  return { command: words };
}

const work = resolve(".conformance");
const resultsDir = join(work, "results");
const suite = new Suite(work);
let renderer;
let tornDown;

function teardown() {
  tornDown ??= (async () => {
    stopChildren();
    await renderer?.browser().close().catch(() => {});
    await suite.stop().catch(() => {});
  })();
  return tornDown;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function report(data, dir) {
  const summary = summarize(data);
  writeFileSync(join(dir, "summary.md"), markdownSummary(summary));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownSummary(summary));
  return summary;
}

async function mergeCommand(args) {
  const out = resolve(args.out ?? resultsDir);
  mkdirSync(out, { recursive: true });
  const data = merge(args.target.map((file) => resolve(file)), out);
  writeFileSync(join(out, "summary.json"), JSON.stringify(data, null, 2));
  console.log(terminalSummary(report(data, out), out));
}

async function variantsCommand(args) {
  await suite.start({ publish: false });
  const plan = findPlan(suite.get("plan/available"), args.plan || defaultPlan);
  const runs = matchingVariants(plan, parseVariant(args.variant));
  const matrix = runs.map((variant) => ({ variant: formatVariant(variant), name: Object.values(variant).join(" · ") }));
  setOutput("matrix", JSON.stringify(matrix));
  console.log(JSON.stringify(matrix, null, 2));
}

async function startOp(target, args) {
  if (target.issuer) return target.issuer;
  const [command, ...rest] = target.command;
  // A single word with spaces is a command line, as npm scripts and workflow inputs give one.
  const shell = !rest.length && /\s/.test(command);
  step(`Starting OP: ${target.command.join(" ")}`);
  const started = startAnnouncing(command, rest, { shell, echo: true });
  if (args.issuer) {
    started.catch(() => {});
    return new URL(args.issuer).origin;
  }
  step("Waiting for an https:// origin on the command's stdout…");
  const { origin } = await deadline(started, "an https:// origin on the command's stdout", 180, {
    hint:
      "No https:// origin yet. The suite reaches the OP over the internet, so the command has to put it on a " +
      "public https address and print it, as tunneld does. Otherwise pass --issuer.",
  });
  return origin;
}

async function runCommand(args) {
  const loaded = await loadConfig(args.config ?? process.env.CONFORMANCE_CONFIG);
  const { target, config } = await resolveTarget(args.target, loaded);
  const remote = Boolean(target.issuer);
  const env = {
    plan: args.plan ?? process.env.CONFORMANCE_PLAN,
    variant: args.variant ?? process.env.CONFORMANCE_VARIANT,
    modules: args.modules ?? process.env.CONFORMANCE_MODULES,
  };
  const interactive = process.stdin.isTTY && !process.env.CI && !env.plan && !env.variant && !env.modules;

  rmSync(resultsDir, { recursive: true, force: true });
  mkdirSync(resultsDir, { recursive: true });
  await suite.start({ publish: true });
  // Every plan with its variants and modules.
  const catalogue = suite.get("plan/available");
  let plan;
  let runs;
  let modules = (env.modules || "").split(",").filter(Boolean);
  if (interactive) {
    plan = await choosePlan(catalogue, tag);
    runs = await chooseVariants(plan);
    modules = await chooseModules(plan, runs.length);
    outro("Starting the run.");
  } else {
    plan = findPlan(catalogue, env.plan || defaultPlan);
    runs = matchingVariants(plan, parseVariant(env.variant));
    if (!runs.length) throw new Error(`no ${plan.planName} variant matches ${env.variant}`);
  }

  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  step(`Plan ${plan.planName}: ${count(runs.length, "variant")}, ${count(modules.length || plan.modules.length, "module")}`);
  const issuer = await startOp(target, args);
  step(`Issuer: ${issuer}`);
  step(`Waiting for ${issuer}/.well-known/openid-configuration…`);
  const discovery = await poll("discovery", 300, async () => {
    const res = await request(`${issuer}/.well-known/openid-configuration`);
    return res.ok && res.json();
  });

  renderer = await startRenderer();
  if (!config.browser) console.warn("The config has no browser tasks: every module waits for a person to sign in.");
  step(`Writing ${runs.length === 1 ? "the suite config" : `${runs.length} suite configs`}…`);
  const clients = new Clients();
  // One at a time: concurrent registrations can each land on a different instance of an OP
  // that keeps its clients in memory.
  const configs = [];
  for (const [index, variant] of runs.entries()) {
    configs.push(
      await writeSuiteConfig(work, index, {
        config,
        clients,
        issuer,
        suite: suite.url,
        discovery,
        variant,
        remote,
        rendering: Boolean(renderer),
      }),
    );
  }

  const collector = new Collector(suite, resultsDir, plan.planName, tag);
  const runner = new Runner({ suite, venv: suite.venv, resultsDir, collector, renderer, issuer });
  const chosen = modules.length ? modules : plan.modules.map(({ testModule }) => testModule);
  const runnerModules = chosen.filter((module) => module !== rotateKeys);
  const plans = runnerModules.length
    ? await runner.plans(plan.planName, runs, configs, runnerModules)
    : runs.map((variant, index) => runner.createPlan(plan.planName, variant, readFileSync(configs[index], "utf8")));
  if (chosen.includes(rotateKeys)) {
    if (config.rotateKeys) {
      for (const id of plans) {
        await runner.rotateKeys(id, discovery.jwks_uri, () => config.rotateKeys({ issuer, discovery, remote }));
        collector.settled.delete(id);
        collector.write(plans);
      }
    } else {
      console.warn(`Skipped ${rotateKeys}: the config has no rotateKeys.`);
    }
  }
  let summary;
  if (plans.length) {
    collector.settled.clear();
    summary = report(collector.write(plans), resultsDir);
  }
  if (plans.length !== runs.length) throw new Error(`${plans.length} of ${runs.length} plans ran`);
  return summary;
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    return 2;
  }
  if (args.help) {
    console.log(usage);
    return 0;
  }
  if (args.command === "merge") {
    await mergeCommand(args);
    return 0;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await teardown();
      process.exit(130);
    });
  }
  let summary;
  let code = 0;
  try {
    if (args.command === "variants") await variantsCommand(args);
    else summary = await runCommand(args);
  } catch (error) {
    if (error instanceof Cancelled) {
      code = 130;
    } else if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`);
      code = 2;
    } else {
      console.error(error);
      code = 1;
    }
  } finally {
    await teardown();
  }
  // Last, so suite and teardown output do not bury it.
  if (summary) console.log(`\n${terminalSummary(summary, resultsDir)}`);
  return code;
}
