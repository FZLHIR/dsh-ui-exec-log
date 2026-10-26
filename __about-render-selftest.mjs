/**
 * Render smoke test for the About DSH settings page.
 *
 * The unit tests assert helper shapes; this one calls the real component with
 * a tiny hooks runtime, so a missing constant or a bad branch in the render
 * path throws here instead of in the browser. The fake `fetch` answers the
 * layout route with a fixed framework, so both panes are exercised end to end.
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
  revision: 2,
  root: ROOT,
  home: HOME,
  app: true,
  version: "0.2.1-rc.2",
  profiles: ["desktop"],
  profile: "desktop",
  rows: [
    { key: "root", path: ROOT, depth: 0, role: "root", kind: "dir", children: 3, bytes: 856000000 },
    { key: "launcher", path: ROOT + "\\DSH.cmd", depth: 1, role: "launcher", parent: "root", kind: "file", bytes: 2470 },
    { key: "app", path: ROOT + "\\APP", depth: 1, role: "app", parent: "root", kind: "dir", children: 2, bytes: 467435193, truncated: false },
    { key: "home", path: HOME, depth: 2, role: "home", parent: "data", kind: "dir", children: 9, bytes: 381634353, truncated: true },
    { key: "sessions", path: HOME + "\\sessions", depth: 3, role: "sessions", parent: "home", kind: "dir", children: 2 },
    { key: "workspace", path: ROOT + "\\workspace", depth: 1, role: "workspace", parent: "root", kind: "dir", children: 6, bytes: 3640925 },
  ],
  composition: {
    profile: "desktop",
    bundles: ["@deepseek-ai/dsh-base", "@local/dsh-ui-exec-log"],
    patchIds: ["llm-pi-ai", "agent-default-model"],
  },
  plugins: {
    error: "",
    inventory: {
      entries: [{ entryId: "e1", moduleName: "@deepseek-ai/dsh-sandbox-policy", enabled: false, fiberPhase: "pending" }],
      presets: [{ name: "standard", rows: 3 }],
    },
    bundles: [
      {
        name: "@deepseek-ai/dsh-base",
        version: "1.2.3",
        source: "installation",
        enabled: true,
        meta: { title: "Base bundle", description: "core runtime and defaults" },
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
  },
};

/** A hooks runtime just good enough for one mounted component. */
function createRuntime(fetchImpl) {
  const state = { slots: [], cursor: 0, effects: [], dirty: false };
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children,
    }),
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    Component: class {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(next) {
        this.state = Object.assign({}, this.state, typeof next === "function" ? next(this.state) : next);
      }
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
  const layoutFetch = async (url) => {
    if (typeof url !== "string" || !url.startsWith("/fzl-toolkit/layout")) throw new Error("unexpected fetch " + url);
    return { status: 200, json: async () => OVERVIEW };
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
const AboutBody = runtime.module.__internals.AboutBody;
assert.equal(typeof AboutBody, "function");

const t = (key, values) => (values === undefined ? key : key + "(" + Object.values(values).join(",") + ")");

const tree = await mount(AboutBody, { t: t }, runtime.state);
const text = textOf(tree).join(" ");

// Header facts.
assert.ok(text.includes("aboutTitle"), "page title renders");
assert.ok(text.includes("0.2.1-rc.2"), "version renders");
assert.ok(text.includes("desktop"), "profile renders");
assert.ok(text.includes(ROOT), "install root renders");
assert.ok(text.includes(HOME), "data home renders");

// Framework pane: named places with roles, not a file listing.
assert.ok(text.includes("aboutFramework"), "framework pane title");
assert.ok(text.includes("aboutRole_root"), "the root row explains itself");
assert.ok(text.includes("aboutRole_home"), "the data home row explains itself");
assert.ok(text.includes("aboutRole_sessions"), "a nested row renders while its parent is open");
assert.ok(text.includes("DSH.cmd"), "the launcher is named");
assert.ok(text.includes("446 MB"), "the app size is formatted: " + text.slice(0, 160));
assert.ok(text.includes("aboutTruncated"), "a cut-off scan is marked");
assert.ok(text.includes("aboutComposition(2,2)"), "composition counts render");

// Composition rows name the bundles.
assert.ok(text.includes("@deepseek-ai/dsh-base"));
assert.ok(text.includes("@local/dsh-ui-exec-log"));

// Plugin pane: bundles start folded, each carries a one-line description.
assert.ok(text.includes("aboutPluginsTitle"));
assert.ok(text.includes("aboutOwnPackage"));
assert.ok(text.includes("core runtime and defaults"), "the bundle description renders");
assert.ok(!text.includes("@deepseek-ai/dsh-sandbox-policy"), "bundle rows start folded");
assert.ok(text.includes("aboutAgentPresets"));
assert.ok(text.includes("aboutItems(3)"), "the preset entry count renders");

// A Host that never answers leaves the page standing, with the restart hint.
const downRuntime = createRuntime(async () => ({
  status: 502,
  json: async () => {
    throw new Error("not JSON");
  },
}));
const down = await mount(
  downRuntime.module.__internals.AboutBody,
  { t: t },
  downRuntime.state,
);
const downText = textOf(down).join(" ");
assert.ok(downText.includes("aboutHostDown"), "a missing Host half is reported");

console.log("about render selftest: ok");
