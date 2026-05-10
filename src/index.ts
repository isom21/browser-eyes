#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CDPClient } from "./cdp.js";

const cdp = new CDPClient();

const server = new Server(
  { name: "browser-eyes", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "look",
      description:
        "Capture the current state of the user's active browser tab in one shot: screenshot (image), URL, title, recent console messages, and recent failed network requests. Call this whenever you need to see what the user sees, verify a UI change, or check whether the browser is reporting any errors. Buffers fill from the moment this MCP server connects to Chrome — earlier events are lost.",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: {
            type: "boolean",
            description: "If true, capture the full scrollable page (default: just the viewport).",
          },
        },
      },
    },
    {
      name: "navigate",
      description:
        "Navigate the active tab to a URL. Waits for the page's load event (or up to timeoutMs). Essential when running a headless browser, since there's no UI to type a URL into. Returns the resolved URL and page title after load.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to (e.g. http://localhost:3000)." },
          timeoutMs: { type: "number", description: "Max time to wait for load event (default 10000)." },
        },
        required: ["url"],
      },
    },
    {
      name: "eval_js",
      description:
        "Evaluate a JavaScript expression in the active browser tab and return the result. Useful for inspecting state (`window.__REDUX_STORE__.getState()`), querying DOM (`document.querySelector('...').innerText`), or triggering actions (`document.querySelector('button').click()`). Top-level await is supported.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "JavaScript expression to evaluate.",
          },
        },
        required: ["expression"],
      },
    },
    {
      name: "list_tabs",
      description: "List all open Chrome tabs (index, URL, title). Use to find the right tab when select_tab is needed.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_tab",
      description:
        "Switch the active tab being inspected. Pass an index (e.g. \"0\") or a substring matched against URL/title. Resets console and network-error buffers.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Tab index (numeric string) or substring of URL/title.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "clear_buffers",
      description:
        "Clear the console-message and network-error buffers. Useful before a step you want to observe in isolation (e.g. clear, click button, look).",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "look": {
        const fullPage = (args as { fullPage?: boolean } | undefined)?.fullPage ?? false;
        const snap = await cdp.snapshot({ fullPage });
        const summary =
          `URL: ${snap.url}\n` +
          `Title: ${snap.title}\n\n` +
          `Recent console (${snap.console.length}):\n` +
          (snap.console.slice(-30).join("\n") || "(none)") +
          `\n\nRecent network errors (${snap.networkErrors.length}):\n` +
          (snap.networkErrors.slice(-30).join("\n") || "(none)");
        return {
          content: [
            { type: "image", data: snap.screenshot, mimeType: "image/png" },
            { type: "text", text: summary },
          ],
        };
      }

      case "navigate": {
        const { url, timeoutMs } = args as { url: string; timeoutMs?: number };
        const result = await cdp.navigate(url, timeoutMs);
        return {
          content: [
            { type: "text", text: `Navigated to: ${result.url}\nTitle: ${result.title}` },
          ],
        };
      }

      case "eval_js": {
        const expr = (args as { expression: string }).expression;
        const result = await cdp.evalJs(expr);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "undefined" }],
        };
      }

      case "list_tabs": {
        const tabs = await cdp.listTabs();
        return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
      }

      case "select_tab": {
        const query = (args as { query: string }).query;
        const tab = await cdp.selectTab(query);
        return { content: [{ type: "text", text: `Selected tab: ${tab.title}\n${tab.url}` }] };
      }

      case "clear_buffers": {
        await cdp.clearBuffers();
        return { content: [{ type: "text", text: "Buffers cleared." }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
