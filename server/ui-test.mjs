import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const html = await readFile(
  fileURLToPath(new URL("../plugin/ui.html", import.meta.url)),
  "utf8",
);
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, "Plugin UI script was not found.");

function fakeElement() {
  const classes = new Set();
  return {
    disabled: false,
    onclick: null,
    textContent: "",
    classList: {
      contains(name) {
        return classes.has(name);
      },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

const elements = new Map(
  ["connect", "disconnect", "status", "dot"].map((id) => [id, fakeElement()]),
);
let now = 10000;
let intervalCallback = null;
let heartbeatShouldFail = false;
const fetchCalls = [];

async function fetch(url, options = {}) {
  fetchCalls.push({ url, options });
  if (url.endsWith("/v1/plugin/heartbeat") && heartbeatShouldFail) {
    heartbeatShouldFail = false;
    throw new Error("Temporary bridge failure.");
  }
  if (url.endsWith("/v1/commands/next")) {
    return { ok: true, status: 204 };
  }
  return { ok: true, status: 200 };
}

vm.runInNewContext(scriptMatch[1], {
  Date: { now: () => now },
  Math,
  document: {
    getElementById(id) {
      return elements.get(id);
    },
  },
  encodeURIComponent,
  fetch,
  parent: { postMessage() {} },
  setInterval(callback) {
    intervalCallback = callback;
    return 1;
  },
  window: {},
});

assert.equal(typeof intervalCallback, "function");
assert.equal(elements.get("status").textContent, "未连接");

await elements.get("connect").onclick();
assert.equal(elements.get("status").textContent, "已连接");
assert.equal(elements.get("dot").classList.contains("connected"), true);

heartbeatShouldFail = true;
now += 650;
await intervalCallback();
assert.match(elements.get("status").textContent, /1 秒后重试/);
assert.equal(elements.get("dot").classList.contains("connecting"), true);

const callsBeforeBackoff = fetchCalls.length;
now += 999;
await intervalCallback();
assert.equal(fetchCalls.length, callsBeforeBackoff);

now += 1;
await intervalCallback();
assert.equal(elements.get("status").textContent, "已连接");
assert.equal(elements.get("dot").classList.contains("connected"), true);

await elements.get("disconnect").onclick();
assert.equal(elements.get("status").textContent, "未连接");
const callsAfterDisconnect = fetchCalls.length;
now += 10000;
await intervalCallback();
assert.equal(fetchCalls.length, callsAfterDisconnect);

process.stdout.write("Figma plugin reconnect UI test passed.\n");
