import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const entryIcons = { FAILURE: "❌", WARNING: "⚠️" };

export const icons = {
  PASSED: "✅",
  WARNING: "⚠️",
  REVIEW: "👀",
  SKIPPED: "⏭️",
  FAILED: "❌",
  RUNNING: "⏳",
};

// Writes what fills a REVIEW condition's slot: the uploaded image, or the page source the
// suite's browser saved instead. Returns the file's path, if there was one.
function saveScreenshot(entry, base) {
  const image = entry.img?.match(/^data:image\/(\w+);base64,(.*)$/s);
  const [path, data] = image
    ? [`${base}.${image[1]}`, Buffer.from(image[2], "base64")]
    : entry.page_source
      ? [`${base}.html`, entry.page_source]
      : [];
  if (!path) return undefined;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

// Reads a run's results from the suite into summary.json's shape:
// { name, tag, runs: [{ variant, modules: [{ testModule, result, conditions, shots }] }] }
export class Collector {
  constructor(suite, resultsDir, name, tag) {
    Object.assign(this, { suite, resultsDir, name, tag });
    // Finished modules no longer change: instance -> module.
    this.finished = new Map();
    // Plans the runner has moved past no longer change, until rotate-keys runs in them.
    this.settled = new Map();
  }

  module(instance, testModule, dir) {
    if (this.finished.has(instance)) return this.finished.get(instance);
    const { status, result } = this.suite.get(`info/${instance}`);
    const log = this.suite.get(`log/${instance}`);
    const conditions = log
      .filter((entry) => entryIcons[entry.result])
      .map(({ result: level, src, msg, url }) => ({
        level,
        src,
        msg: String(url ? `${msg} at ${new URL(url).pathname}` : msg).replace(/\s+/g, " "),
      }));
    if (status !== "FINISHED" && status !== "INTERRUPTED") {
      return { testModule, result: "RUNNING", conditions, shots: [] };
    }
    const shots = [];
    if (result === "REVIEW") {
      for (const entry of log.filter((entry) => entry.result === "REVIEW")) {
        const path = saveScreenshot(entry, join(this.resultsDir, "screenshots", dir, `${testModule}-${entry.src}`));
        shots.push({ src: entry.src, msg: entry.msg, file: path && relative(this.resultsDir, path) });
      }
    }
    const module = { testModule, result: result ?? "UNKNOWN", conditions, shots };
    this.finished.set(instance, module);
    return module;
  }

  collect(plans) {
    const runs = plans.map((id, index) => {
      let info = this.settled.get(id);
      if (!info) {
        info = this.suite.get(`plan/${id}`);
        if (index < plans.length - 1) this.settled.set(id, info);
      }
      const variant = info.variant ?? {};
      const dir = Object.values(variant).join("-").replace(/[^\w.-]+/g, "-") || this.name;
      const modules = info.modules
        .filter(({ instances = [] }) => instances.length)
        .map(({ testModule, instances }) => this.module(instances.at(-1), testModule, dir));
      return { variant, modules };
    });
    return { name: this.name, tag: this.tag, runs };
  }

  // summary.json and summary.md, under resultsDir.
  write(plans) {
    const data = this.collect(plans);
    writeFileSync(join(this.resultsDir, "summary.json"), JSON.stringify(data, null, 2));
    writeFileSync(join(this.resultsDir, "summary.md"), markdownSummary(summarize(data)));
    return data;
  }
}

// summary.json files from several jobs, as one, with screenshot paths relative to into.
export function merge(files, into) {
  const all = files.map((file) => {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const run of data.runs) {
      for (const module of run.modules) {
        for (const shot of module.shots) {
          if (shot.file) shot.file = relative(into, join(dirname(file), shot.file));
        }
      }
    }
    return data;
  });
  if (!all.length) throw new Error("no summary.json to merge");
  return { name: all[0].name, tag: all[0].tag, runs: all.flatMap(({ runs }) => runs) };
}

// Results as tables; markdownSummary and terminalSummary render them.
export function summarize({ name, tag, runs }) {
  const totals = {};
  // module -> labels of the runs it ran in
  const ran = new Map();
  // module -> condition -> { icon, src, msg, labels }
  const why = new Map();
  // REVIEW conditions and where their screenshot was saved
  const screenshots = [];
  const variants = runs.map(({ variant }) => variant);
  const axes = [...new Set(variants.flatMap(Object.keys))];
  // A run is named by the values that differ between the runs; the others are shared.
  const varying = axes.filter((axis) => new Set(variants.map((variant) => variant[axis])).size > 1);
  const shared = axes
    .filter((axis) => !varying.includes(axis))
    .map((axis) => variants[0][axis])
    .join(" · ");
  const runLabel = (variant) => varying.map((axis) => variant[axis] ?? "-").join(" · ") || shared || name;
  const labelled = runs.map(({ variant, modules }) => {
    const label = runLabel(variant);
    const results = {};
    for (const { testModule, result, conditions, shots } of modules) {
      totals[result] = (totals[result] ?? 0) + 1;
      results[testModule] = icons[result] ?? result;
      if (!ran.has(testModule)) ran.set(testModule, new Set());
      ran.get(testModule).add(label);
      for (const shot of shots) screenshots.push({ module: testModule, label, ...shot });
      for (const { level, src, msg } of conditions) {
        if (!why.has(testModule)) why.set(testModule, new Map());
        const found = why.get(testModule);
        const key = `${level}|${src}|${msg}`;
        if (!found.has(key)) found.set(key, { icon: entryIcons[level], src, msg, labels: new Set() });
        found.get(key).labels.add(label);
      }
    }
    return { label, results };
  });

  const modules = [...new Set(labelled.flatMap(({ results }) => Object.keys(results)))];
  const tables = [
    {
      title: name,
      note: varying.length && shared ? `every run at ${shared}` : "",
      header: ["module", ...labelled.map(({ label }) => label)],
      rows: modules.map((module) => [module, ...labelled.map(({ results }) => results[module] ?? "")]),
    },
  ];

  const reasons = [...why].map(([module, conditions]) => ({
    module,
    icon: [...conditions.values()].some(({ icon }) => icon === "❌") ? "❌" : "⚠️",
    conditions: [...conditions.values()].map(({ icon, src, msg, labels }) => {
      const missing = [...ran.get(module)].filter((label) => !labels.has(label));
      const where = !missing.length
        ? "all runs"
        : missing.length < labels.size
          ? `all except ${missing.join(", ")}`
          : [...labels].join(", ");
      return { icon, src, msg, where };
    }),
  }));

  return {
    totals: Object.entries(totals)
      .map(([result, n]) => `${icons[result] ?? result} ${result.toLowerCase()} ${n}`)
      .join(" · "),
    name,
    tag,
    tables,
    reasons,
    screenshots,
  };
}

// Markdown, with screenshot links relative to the directory it is written to.
export function markdownSummary({ name, tag, totals, tables, reasons, screenshots }) {
  const escape = (text) => String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [`# ${name} (${tag})`, "", totals];
  for (const { title, note, header, rows } of tables) {
    lines.push("", `## ${title}`, "");
    if (note) lines.push(`${note[0].toUpperCase()}${note.slice(1)}.`, "");
    lines.push(
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.join(" | ")} |`),
    );
  }
  if (reasons.length) lines.push("", "## Why");
  for (const { module, icon, conditions } of reasons) {
    lines.push("", `<details><summary>${icon} ${module}</summary>`, "");
    for (const { icon, src, msg, where } of conditions) {
      lines.push(`- ${icon} \`${src}\`: ${escape(msg)} _(${where})_`);
    }
    lines.push("", "</details>");
  }
  if (screenshots.length) lines.push("", "## Screenshots");
  for (const { module, label, src, msg, file } of screenshots) {
    lines.push("", `### ${icons.REVIEW} ${module} _(${label})_`, "", `**${src}**`, "", escape(msg));
    if (file) lines.push("", file.endsWith(".html") ? `[${file}](${file})` : `![${src}](${file})`);
  }
  return `${lines.join("\n")}\n`;
}

// Terminal columns: pictographs take two, variation selectors none.
function width(text) {
  return [...text].reduce(
    (sum, char) => sum + (char === "️" ? 0 : /\p{Extended_Pictographic}/u.test(char) ? 2 : 1),
    0,
  );
}

export function terminalSummary({ name, tag, totals, tables, reasons, screenshots }, resultsDir) {
  const tty = process.stdout.isTTY;
  const bold = (text) => (tty ? `\x1b[1m${text}\x1b[0m` : text);
  const dim = (text) => (tty ? `\x1b[2m${text}\x1b[0m` : text);
  // OSC 8 hyperlink
  const link = (text, path) => `\x1b]8;;${pathToFileURL(path)}\x1b\\${text}\x1b]8;;\x1b\\`;
  const lines = [bold(`${name} (${tag})`), totals];
  for (const { title, note, header, rows } of tables) {
    const widths = header.map((_, i) => Math.max(...[header, ...rows].map((row) => width(row[i]))));
    const line = (row) => row.map((cell, i) => cell + " ".repeat(widths[i] - width(cell))).join("  ").trimEnd();
    lines.push("", note ? `${bold(title)} ${dim(`(${note})`)}` : bold(title), `  ${dim(line(header))}`);
    lines.push(...rows.map((row) => `  ${line(row)}`));
  }
  if (reasons.length) lines.push("", bold("Why"));
  for (const { module, icon, conditions } of reasons) {
    lines.push(`${icon} ${module}`);
    for (const { icon, src, msg, where } of conditions) {
      lines.push(`    ${icon} ${src}`, `        ${dim(`${msg} (${where})`)}`);
    }
  }
  if (screenshots.length) lines.push("", bold("Screenshots"));
  for (const { module, label, src, msg, file } of screenshots) {
    const path = file && join(resultsDir, file);
    lines.push(
      `${icons.REVIEW} ${module} ${dim(`(${label})`)}`,
      `    ${path && tty ? link(src, path) : src}`,
      `        ${dim(msg)}`,
    );
    if (!path) lines.push(`        ${dim("no screenshot")}`);
    else if (!tty) lines.push(`        ${relative(process.cwd(), path)}`);
  }
  lines.push("", dim(`Saved ${relative(process.cwd(), join(resultsDir, "summary.md"))}`));
  return lines.join("\n");
}
