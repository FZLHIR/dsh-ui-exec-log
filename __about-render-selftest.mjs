/**
 * Render smoke test for the About DSH settings page.
 *
 * The unit tests assert helper shapes; this one calls the real component with
 * a tiny hooks runtime, so a missing constant or a bad branch in the render
 * path throws here instead of in the browser. The fake `fetch` answers the
 * layout route with a fixed tree, so both panes are exercised end to end.
 *
 * Run: node __about-render-selftest.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = "D:\\P\\DSH";
const HOME = "D:\\P\\DSH\\data\\dsh";

const OVERVIEW = {
  ok: true,
  revision: 1,
  root: ROOT,
  home: HOME,
  app: true,
  version: "0.2.1-rc.2",
  profiles: ["desktop"],
  profile: "desktop",
  totals: { APP: 467435193, data: 381634353, workspace: 3640925 },
  total: 3,
  more: 0,
  entries: [
    { name: "APP", kind: "dir", bytes: 467435193, files: 22, children: 2, truncated: false },
    { name: "data", kind: "dir", bytes: 381634353, files: 900, children: 6, truncated: true },
    { name: "DSH.cmd", kind: "file", bytes: 2470 },
  ],
};

function level(path) {
  if (path === ROOT) return OVERVIEW;
  return {
    ok: true,
    revision: 1,
    root: ROOT,
    home: HOME,
    path: path,
    total: 1,
    more: 0,
    entries: [{ name: "AGENTS.md", kind: "file", bytes: 4096 }],
  };
}

/** A hooks runtime just good enough for one mounted component. */
function createRuntime(fetchImpl) {
  const state = { slots: [], cursor: 0, effects: [], ran: 0 };
  const layoutFetch = async (url) => {
    if (typeof url !== "string" || !url.startsWith("/fzl-toolkit/layout")) throw new Error("unexpected fetch " + url);
    const target = url.includes("path=") ? decodeURIComponent(url.slice(url.indexOf("path=") + 5).split("&")[0]) : "";
    const payload = target === "" ? OVERVIEW : level(target);
    return { status: 200, json: async () => payload };
  };
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children,
    }),
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
  Component: class {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = Object.assign({}, this.state, typeof next === "function" ? next(this.state) : next); }
  },

    useState: (initial) => {
      const index = state.cursor;
      state.cursor += 1;
      if (state.slots.length <= index) {
        state.slots[index] = typeof initial === "function" ? initial() : initial;
      }
      const set = (next) => {
        state.slots[index] = typeof next === "function" ? next(state.slots[index]) : next;
        state.dirty = true;
      };
      return [state.slots[index], set];
    },
    useEffect: (effect) => {
      state.effects.push(effect);
    },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => (state.entry = entry) } },
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: undefined,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    fetch: fetchImpl === undefined ? layoutFetch : fetchImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("./client.js", import.meta.url), "utf8"), sandbox, {
    filename: "client.js",
  });
  const module = state.entry.factory((name) => {
    if (name === "react") return react;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Switch: () => null };
    throw new Error("unexpected require: " + name);
  });
  return { module, state };
}

/** Render once and run the mount effects; settle by re-rendering on setState. */
async function mount(Component, props, state) {
  let tree;
  for (let pass = 0; pass < 12; pass += 1) {
    state.cursor = 0;
    state.effects = [];
    state.dirty = false;
    tree = Component(props);
    if (pass === 0) {
      for (const effect of state.effects) effect();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (state.dirty !== true) return tree;
  }
  throw new Error("component never settled");
}

/** Text content of a rendered tree, in render order. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === "object" && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out);
  }
  return out;
}

const runtime = createRuntime();
const AboutSection = runtime.module.__internals.AboutBody;
const hookState = runtime.state;
assert.equal(typeof AboutSection, "function");

const t = (key, values) =>
  values === undefined ? key + (typeof key === "string" ? "" : "") : key + "(" + Object.values(values).join(",") + ")";

const plugins = {
  listBundles: () => ({
    ok: true,
    value: [
      {
        name: "@deepseek-ai/dsh-base",
        version: "1.2.3",
        source: "installation",
        enabled: true,
        rows: [{ rowId: "r1", moduleName: "@deepseek-ai/dsh-sandbox-policy", entryId: "e1" }],
      },
      {
        name: "@local/dsh-ui-exec-log",
        version: "0.3.1",
        source: "link:../../workspace/plugins/dsh-ui-exec-log",
        enabled: true,
        rows: [],
      },
    ],
  }),
  listInventory: () => ({
    ok: true,
    value: {
      entries: [{ entryId: "e1", moduleName: "@deepseek-ai/dsh-sandbox-policy", enabled: false, fiberPhase: "pending" }],
      agentPresets: [{ name: "standard", rows: [{ moduleName: "x" }] }],
      managementAvailable: true,
    },
  }),
};

const tree = await mount(
  AboutSection,
  { t: t, listBundles: plugins.listBundles, listInventory: plugins.listInventory },
  hookState,
);
const text = textOf(tree).join(" ");

// The header carries the real installation facts.
assert.ok(text.includes("aboutTitle"), "page title renders");
assert.ok(text.includes("0.2.1-rc.2"), "version renders");
assert.ok(text.includes("desktop"), "profile renders");
assert.ok(text.includes(ROOT), "install root renders");
assert.ok(text.includes(HOME), "data home renders");
assert.ok(text.includes("446 MB"), "the APP total is formatted like a size: " + text.slice(0, 200));

// The tree pane renders the first level, and only the first level.
assert.ok(text.includes("APP"));
assert.ok(text.includes("DSH.cmd"));
assert.ok(text.includes("aboutTruncated"), "a cut-off scan is marked");

// The plugin pane renders bundles, the live entry state, and the own-package badge.
assert.ok(text.includes("@deepseek-ai/dsh-base"));
assert.ok(text.includes("@deepseek-ai/dsh-sandbox-policy"));
assert.ok(text.includes("aboutOwnPackage"));
assert.ok(text.includes("pending"));
assert.ok(text.includes("aboutAgentPresets"));

// A Host that never answers leaves the page standing, with the restart hint.
const downRuntime = createRuntime(async () => ({
  status: 502,
  json: async () => {
    throw new Error("not JSON");
  },
}));
const down = await mount(
  downRuntime.module.__internals.AboutBody,
  { t: t, listBundles: undefined, listInventory: undefined },
  downRuntime.state,
);
const downText = textOf(down).join(" ");
assert.ok(downText.includes("aboutHostDown"), "a missing Host half is reported");
assert.ok(downText.includes("aboutInventoryDown"), "a missing Remote is reported");

console.log("about render selftest: ok");
