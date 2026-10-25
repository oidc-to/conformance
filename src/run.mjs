import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { planName, rotateKeys } from "./plans.mjs";
import { poll, request, step } from "./process.mjs";

// Renders the pages the suite's browser was served, for REVIEW screenshot slots.
export async function startRenderer() {
  return chromium
    .launch()
    .then((browser) => browser.newContext({ javaScriptEnabled: false }))
    .catch((error) => {
      console.error(`Screenshots fall back to page source; Chromium did not start: ${error.message}`);
    });
}

export class Runner {
  constructor({ suite, venv, resultsDir, collector, renderer, issuer }) {
    Object.assign(this, { suite, venv, resultsDir, collector, renderer, issuer });
  }

  // run-test-plan.py, serially, over every variant. Resolves with the plan ids it created.
  plans(name, runs, configs, modules) {
    const args = [
      join(this.suite.dir, "run-test-plan.py"),
      "--export-dir",
      this.resultsDir,
      "--no-parallel",
      ...runs.flatMap((variant, index) => [planName(name, variant, modules.join(",")), configs[index]]),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(join(this.venv, "bin/python"), args, {
        cwd: this.suite.dir,
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          CONFORMANCE_SERVER: `${this.suite.api}/`,
          CONFORMANCE_DEV_MODE: "1",
          // The breaker is for a dead suite; an OP failing every module is expected here.
          CONFORMANCE_MAX_CONSECUTIVE_FAILURES: "1000000",
        },
      });
      const plans = [];
      const screenshots = [];
      // The runner starts a module once the one before it has finished.
      let refreshing;
      const refresh = () => {
        refreshing ??= sleep(1000)
          .then(() => {
            refreshing = undefined;
            this.collector.write(plans);
          })
          .catch((error) => console.error(`summary not updated: ${error.message}`));
      };
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        for (const [, n] of chunk.toString().matchAll(/Running plan \[(\d+)\]/g)) {
          step(`Variant ${n}/${runs.length}: ${Object.values(runs[n - 1] ?? {}).join(" · ") || name}`);
        }
        for (const [, id] of chunk.toString().matchAll(/Created test plan, new id: (\S+)/g)) plans.push(id);
        for (const [, id] of chunk.toString().matchAll(/Created test module, new id: (\S+)/g)) {
          if (this.renderer) screenshots.push(this.fillScreenshots(id));
          refresh();
        }
      });
      child.on("error", reject);
      child.on("close", async () => {
        await Promise.all(screenshots);
        await refreshing;
        resolve(plans);
      });
    });
  }

  createPlan(name, variant, config) {
    const params = new URLSearchParams({ planName: name, variant: JSON.stringify(variant) });
    return this.suite.post(`plan?${params}`, config).id;
  }

  moduleStatus(id, statuses) {
    return poll(`${id} to reach ${statuses.join(" or ")}`, 240, async () => {
      const { status } = this.suite.get(`info/${id}`);
      return statuses.includes(status) && status;
    });
  }

  // The module waits for an operator to rotate the signing key between creating it and starting
  // it, but the runner starts it at once, so it runs here, with rotate doing the operator's part.
  async rotateKeys(planId, jwksUri, rotate) {
    const entry = this.suite.get(`plan/${planId}`).modules.find(({ testModule }) => testModule === rotateKeys);
    if (!entry) return;
    const params = new URLSearchParams({ test: rotateKeys, plan: planId });
    if (entry.variant) params.set("variant", JSON.stringify(entry.variant));
    const { id } = this.suite.post(`runner?${params}`);
    console.log(`Running test module: ${rotateKeys}, new id: ${id}`);
    if ((await this.moduleStatus(id, ["CONFIGURED", "FINISHED", "INTERRUPTED"])) !== "CONFIGURED") return;

    const before = await (await request(jwksUri)).text();
    await rotate();
    await poll("the rotated signing key", 60, async () => (await (await request(jwksUri)).text()) !== before);
    console.log("Rotated the signing key");

    this.suite.post(`runner/${id}`);
    await this.moduleStatus(id, ["FINISHED", "INTERRUPTED"]);
  }

  // Renders a page the suite's browser was served, at the URL it was served from.
  async screenshot({ url, type, body }) {
    const page = await this.renderer.newPage();
    try {
      await page.route(
        (requested) => requested.href === url,
        (route) => route.fulfill({ contentType: type, body }),
      );
      await page.goto(url);
      return await page.screenshot({ fullPage: true });
    } finally {
      await page.close();
    }
  }

  // The first issuer page the suite's browser loaded after a module opened the slot.
  slotPage(log, slot) {
    let response;
    for (const entry of log.slice(log.indexOf(slot) + 1)) {
      if (typeof entry.response_content === "string") {
        response = { type: entry.response_content_type, body: entry.response_content };
      } else if (response && entry.url) {
        if (entry.url.startsWith(this.issuer)) return { url: new URL(entry.url).href, ...response };
        response = undefined;
      }
    }
  }

  // A module that asks for a screenshot waits in WAITING until each of its slots is filled,
  // and the runner gives up on it after 240s.
  fillScreenshots(id) {
    const open = new Map();
    return poll(`${id} to finish`, 300, async () => {
      const { status } = this.suite.get(`info/${id}`);
      if (status === "FINISHED" || status === "INTERRUPTED") return true;
      if (!this.suite.get(`runner/${id}`).browser?.uploadsRequired) return false;
      const log = this.suite.get(`log/${id}`);
      for (const slot of log.filter(({ upload }) => upload && !open.get(upload)?.failed)) {
        open.set(slot.upload, { src: slot.src });
        const page = this.slotPage(log, slot);
        if (!page) continue;
        try {
          const png = await this.screenshot(page);
          this.suite.post(`log/${id}/images/${slot.upload}`, `data:image/png;base64,${png.toString("base64")}`, "text/plain");
          open.delete(slot.upload);
          console.log(`Uploaded a screenshot of ${page.url} for ${slot.src}`);
        } catch (error) {
          open.set(slot.upload, { src: slot.src, failed: true });
          console.error(`No screenshot for ${slot.src} on ${id}: ${error.message}`);
        }
      }
      return false;
    }).catch(() => {
      for (const { src, failed } of open.values()) {
        if (!failed) console.error(`No screenshot for ${src} on ${id}: no page from ${this.issuer} in its log`);
      }
    });
  }
}
