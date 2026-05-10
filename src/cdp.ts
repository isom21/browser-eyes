import CDP from "chrome-remote-interface";

export interface Snapshot {
  screenshot: string;
  url: string;
  title: string;
  console: string[];
  networkErrors: string[];
}

export class CDPClient {
  private client: CDP.Client | null = null;
  private targetId: string | null = null;
  private consoleBuffer: string[] = [];
  private networkErrorBuffer: string[] = [];
  private readonly maxBuffer = 200;
  private readonly host: string;
  private readonly port: number;

  constructor() {
    this.host = process.env.BROWSER_EYES_HOST || "localhost";
    this.port = parseInt(process.env.BROWSER_EYES_PORT || "9222", 10);
  }

  private async pickFirstPageTarget(): Promise<string> {
    const targets = await CDP.List({ host: this.host, port: this.port });
    const pages = targets.filter((t) => t.type === "page");
    if (pages.length === 0) {
      throw new Error(
        `No browser tabs found at ${this.host}:${this.port}. Start Chrome with --remote-debugging-port=${this.port} (see bin/start-chrome.sh).`
      );
    }
    return pages[0].id;
  }

  private async ensureConnected(): Promise<CDP.Client> {
    if (this.client) return this.client;

    if (!this.targetId) {
      this.targetId = await this.pickFirstPageTarget();
    }

    const client = await CDP({
      host: this.host,
      port: this.port,
      target: this.targetId,
    });

    await client.Page.enable();
    await client.Runtime.enable();
    await client.Network.enable();
    await client.Log.enable().catch(() => {});

    client.Runtime.consoleAPICalled((params) => {
      const text = params.args
        .map((a) => {
          if (a.value !== undefined) return String(a.value);
          if (a.description) return a.description;
          return JSON.stringify(a);
        })
        .join(" ");
      this.pushConsole(`[${params.type}] ${text}`);
    });

    client.Runtime.exceptionThrown((params) => {
      const ex = params.exceptionDetails;
      const desc = ex.exception?.description ?? ex.text ?? "(unknown)";
      this.pushConsole(`[exception] ${desc.split("\n")[0]}`);
    });

    client.Log.entryAdded?.((params) => {
      const e = params.entry;
      if (e.level === "error" || e.level === "warning") {
        this.pushConsole(`[${e.source}/${e.level}] ${e.text}`);
      }
    });

    client.Network.responseReceived((params) => {
      if (params.response.status >= 400) {
        this.pushNetErr(`${params.response.status} ${params.response.url}`);
      }
    });

    client.Network.loadingFailed((params) => {
      this.pushNetErr(`FAILED ${params.errorText} (${params.type})`);
    });

    client.on("disconnect", () => {
      this.client = null;
    });

    this.client = client;
    return client;
  }

  private pushConsole(line: string) {
    this.consoleBuffer.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    while (this.consoleBuffer.length > this.maxBuffer) this.consoleBuffer.shift();
  }

  private pushNetErr(line: string) {
    this.networkErrorBuffer.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    while (this.networkErrorBuffer.length > this.maxBuffer) this.networkErrorBuffer.shift();
  }

  async snapshot(opts: { fullPage?: boolean } = {}): Promise<Snapshot> {
    const client = await this.ensureConnected();
    const { data } = await client.Page.captureScreenshot({
      format: "png",
      captureBeyondViewport: opts.fullPage ?? false,
    });

    const url = await client.Runtime.evaluate({ expression: "location.href" });
    const title = await client.Runtime.evaluate({ expression: "document.title" });

    return {
      screenshot: data,
      url: String(url.result.value ?? ""),
      title: String(title.result.value ?? ""),
      console: [...this.consoleBuffer],
      networkErrors: [...this.networkErrorBuffer],
    };
  }

  async evalJs(expression: string): Promise<unknown> {
    const client = await this.ensureConnected();
    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      return {
        error: result.exceptionDetails.text,
        details: result.exceptionDetails.exception?.description,
      };
    }
    return result.result.value;
  }

  async listTabs() {
    const targets = await CDP.List({ host: this.host, port: this.port });
    return targets
      .filter((t) => t.type === "page")
      .map((t, i) => ({ index: i, id: t.id, url: t.url, title: t.title }));
  }

  async selectTab(query: string) {
    const targets = await CDP.List({ host: this.host, port: this.port });
    const pages = targets.filter((t) => t.type === "page");

    let target: (typeof pages)[number] | undefined;
    if (/^\d+$/.test(query)) {
      target = pages[parseInt(query, 10)];
    } else {
      const q = query.toLowerCase();
      target = pages.find(
        (t) => t.url.toLowerCase().includes(q) || (t.title ?? "").toLowerCase().includes(q)
      );
    }
    if (!target) throw new Error(`No tab matching "${query}". Use list_tabs to see available tabs.`);

    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this.targetId = target.id;
    this.consoleBuffer = [];
    this.networkErrorBuffer = [];
    await this.ensureConnected();
    return { id: target.id, url: target.url, title: target.title };
  }

  async clearBuffers() {
    this.consoleBuffer = [];
    this.networkErrorBuffer = [];
  }
}
