import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stat } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));

export class ChromeManager {
  private readonly host: string;
  private readonly port: number;
  private readonly launcherPath: string;
  private readonly autoSpawn: boolean;
  private spawnedByUs = false;
  private spawnPromise: Promise<void> | null = null;

  constructor() {
    this.host = process.env.BROWSER_EYES_HOST || "localhost";
    this.port = parseInt(process.env.BROWSER_EYES_PORT || "9222", 10);
    this.autoSpawn = process.env.BROWSER_EYES_AUTO_SPAWN !== "0";
    // dist/chrome-manager.js → ../bin/start-chrome.sh
    this.launcherPath =
      process.env.BROWSER_EYES_LAUNCHER ||
      resolve(here, "..", "bin", "start-chrome.sh");
  }

  ownsBrowser(): boolean {
    return this.spawnedByUs;
  }

  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<void> {
    if (await this.isReachable()) return;

    if (!this.autoSpawn) {
      throw new Error(
        `No Chrome reachable at ${this.host}:${this.port} and auto-spawn is disabled ` +
          `(BROWSER_EYES_AUTO_SPAWN=0). Start it manually with bin/start-chrome.sh.`
      );
    }

    if (this.host !== "localhost" && this.host !== "127.0.0.1") {
      throw new Error(
        `Cannot auto-spawn Chrome on a remote host (${this.host}). ` +
          `Start it manually there or set BROWSER_EYES_HOST=localhost.`
      );
    }

    if (!this.spawnPromise) {
      this.spawnPromise = this.runLauncher().finally(() => {
        this.spawnPromise = null;
      });
    }
    await this.spawnPromise;
  }

  private async runLauncher(): Promise<void> {
    try {
      await stat(this.launcherPath);
    } catch {
      throw new Error(
        `Chrome launcher not found at ${this.launcherPath}. ` +
          `Set BROWSER_EYES_LAUNCHER to its path.`
      );
    }

    process.stderr.write(`[browser-eyes] no Chrome on :${this.port}, spawning one…\n`);

    return new Promise<void>((resolveP, reject) => {
      const child = spawn("bash", [this.launcherPath], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`start-chrome.sh did not return within 30s.\n${stderr}`));
      }, 30_000);

      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });

      child.on("exit", async (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          this.spawnedByUs = true;
          process.stderr.write(`[browser-eyes] Chrome spawned and CDP reachable.\n`);
          resolveP();
          return;
        }
        // Exit-1 with "Already running" means a parallel race won; CDP is up.
        if (stderr.includes("Already running") && (await this.isReachable())) {
          process.stderr.write(`[browser-eyes] Chrome already running (not spawned by us).\n`);
          resolveP();
          return;
        }
        reject(
          new Error(
            `start-chrome.sh exited ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`
          )
        );
      });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.spawnedByUs) return;
    process.stderr.write(`[browser-eyes] stopping spawned Chrome…\n`);
    await new Promise<void>((resolveP) => {
      const child = spawn("bash", [this.launcherPath, "--stop"], {
        env: process.env,
        stdio: "ignore",
      });
      const t = setTimeout(() => {
        child.kill();
        resolveP();
      }, 5000);
      child.on("exit", () => {
        clearTimeout(t);
        resolveP();
      });
      child.on("error", () => {
        clearTimeout(t);
        resolveP();
      });
    });
    this.spawnedByUs = false;
  }
}
