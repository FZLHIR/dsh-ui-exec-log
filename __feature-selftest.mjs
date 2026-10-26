/**
 * Switch test for the toolkit's per-feature gates.
 *
 * The bundle is one plugin with three independently switchable features. This
 * script materializes the client half, applies it against a fake client context,
 * and asserts that each switch adds and removes exactly its own seats.
 *
 * Run: node __feature-selftest.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const react = {
  createElement: () => null,
  useMemo: (factory) => factory(),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  Component: class {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = Object.assign({}, this.state, typeof next === "function" ? next(this.state) : next); }
  },

};

const store = new Map();

function makeContext() {
  const slots = [];
  const registrations = [];
  const tabTypes = [];
  const effects = [];
  const ctx = {
    effect(factory, label) {
      effects.push(label);
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      resolveText: (value) => (typeof value === "string" ? value : undefined),
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        const entry = { name, dispose };
        slots.push(entry);
        return () => {
          const index = slots.indexOf(entry);
          if (index >= 0) slots.splice(index, 1);
          if (typeof dispose === "function") dispose();
        };
      },
      register(config) {
        registrations.push(config);
        return () => {
          const index = registrations.indexOf(config);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
    sidebarRightTabs: {
      register: () => {
        tabTypes.push("exec-log");
        return () => {
          const index = tabTypes.indexOf("exec-log");
          if (index >= 0) tabTypes.splice(index, 1);
        };
      },
    },
    sidebarRight: { openTab: () => {} },
    jobs: { state: {}, watchRows: () => () => {}, observe: () => () => {} },
    remote: { pluginManager: {} },
  };
  return { ctx, slots, registrations, tabTypes, effects };
}

function load() {
  let registered;
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => (registered = entry) } },
    console,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    document: undefined,
    fetch: async () => ({ json: async () => ({}) }),
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("./client.js", import.meta.url), "utf8"), sandbox, {
    filename: "client.js",
  });
  return registered.factory((name) => {
    if (name === "react") return react;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Switch: () => null };
    throw new Error(`unexpected require: ${name}`);
  });
}

const ALL = [
  "plugins.bundle.config",
  "settings.section",
  "settings.section",
  "shell.overlay",
  "sidebar.right.pane.tab",
  "sidebar.right.pane.tab.title",
  "sidebar.workspaces.session.menu.item",
];

const exports = load();
const fake = makeContext();
exports.apply(fake.ctx);

const names = () => fake.slots.map((entry) => entry.name).sort();

assert.deepEqual(names(), ALL);
assert.deepEqual(fake.tabTypes, ["exec-log"]);
// Every seat renders localized copy, so every registration must name its locale;
// without `locale` the owner passes no `t` and raw keys reach the page.
for (const registration of fake.registrations) {
  if (registration.name === "shell.overlay") continue; // draws no localized copy
  assert.equal(registration.locale, "execLog", `slot ${registration.name} must declare its locale`);
}
const bundleConfig = fake.registrations.find((registration) => registration.name === "plugins.bundle.config");
assert.ok(bundleConfig, "the bundle's own page must carry the feature switches");
assert.ok(fake.effects.some((label) => label === "fzl-toolkit: execution log"));
assert.ok(fake.effects.some((label) => label === "fzl-toolkit: session deletion"));

const flags = exports.__internals.featureFlags;

// Execution log off: its tab type, body, title and chat action leave; the rest stays.
flags.set("execLog", false);
assert.deepEqual(names(), [
  "plugins.bundle.config",
  "settings.section",
  "settings.section",
  "sidebar.workspaces.session.menu.item",
]);
assert.deepEqual(fake.tabTypes, []);

assert.deepEqual(names(), [
  "plugins.bundle.config",
  "settings.section",
  "settings.section",
  "sidebar.workspaces.session.menu.item",
]);

// Session deletion off: the row menu entry leaves.
flags.set("sessionDelete", false);
assert.deepEqual(names(), ["plugins.bundle.config", "settings.section", "settings.section"]);

// Turning everything back on restores exactly the original seats.
flags.set("execLog", true);
flags.set("sessionDelete", true);
assert.deepEqual(names(), ALL);
assert.deepEqual(fake.tabTypes, ["exec-log"]);

// The choice is durable and survives a fresh load.
assert.equal(store.get("dsh-exec-log.features"), JSON.stringify({ execLog: true, sessionDelete: true }));
store.set("dsh-exec-log.features", JSON.stringify({ execLog: true, sessionDelete: false }));
const reloaded = load();
const second = makeContext();
reloaded.apply(second.ctx);
assert.deepEqual(
  second.slots.map((entry) => entry.name).sort(),
  [
      "plugins.bundle.config",
    "settings.section",
    "settings.section",
    "shell.overlay",
      "sidebar.right.pane.tab",
    "sidebar.right.pane.tab.title",
  ],
);

// --- About DSH: the pure half of the layout page -------------------------

const { pluginGraph, unwrapRemote, childPath, layoutUrl } = exports.__internals;

// Path joining follows the separator the parent already uses.
assert.equal(childPath("D:\\P\\DSH", "APP"), "D:\\P\\DSH\\APP");
assert.equal(childPath("D:\\P\\DSH\\", "APP"), "D:\\P\\DSH\\APP");
assert.equal(childPath("/usr/local", "bin"), "/usr/local/bin");
assert.equal(childPath("", "APP"), "APP");

// The route carries a level only when one is named.
assert.equal(layoutUrl("", false), "/fzl-toolkit/layout");
assert.equal(layoutUrl("D:\\P\\DSH", false), "/fzl-toolkit/layout?path=D%3A%5CP%5CDSH");
assert.equal(layoutUrl(undefined, true), "/fzl-toolkit/layout?refresh=1");

// Remote answers unwrap both ways, and a failure is `undefined` rather than a throw.
assert.equal(unwrapRemote({ ok: true, value: [1] }).length, 1);
assert.equal(unwrapRemote({ ok: false, error: { code: "x" } }), undefined);
assert.deepEqual(unwrapRemote([1, 2]), [1, 2]);
assert.equal(unwrapRemote(undefined), undefined);

// A bundle row resolves to its live entry by entry id first, module name second.
const bundles = [
  {
    name: "@deepseek-ai/dsh-base",
    version: "1.0.0",
    source: "installation",
    enabled: true,
    rows: [
      { rowId: "a", moduleName: "@deepseek-ai/dsh-base", entryId: "entry-1" },
      { rowId: "b", moduleName: "@deepseek-ai/dsh-sandbox-policy" },
      { rowId: "c", moduleName: "@deepseek-ai/dsh-retired" },
    ],
  },
  { name: "@local/dsh-ui-exec-log", enabled: false, rows: [] },
];
const inventory = {
  entries: [
    { entryId: "entry-1", moduleName: "@deepseek-ai/dsh-base", enabled: true, fiberPhase: "active" },
    { entryId: "entry-2", moduleName: "@deepseek-ai/dsh-sandbox-policy", enabled: false, fiberPhase: "pending" },
  ],
  agentPresets: [{ name: "standard", rows: [{ moduleName: "x" }] }],
};
const graph = pluginGraph(bundles, inventory);
assert.equal(graph.groups.length, 2);
const base = graph.groups[0];
assert.deepEqual(base.rows.map((row) => row.key), ["a", "b", "c"]);
assert.deepEqual(base.rows.map((row) => row.live), [true, true, false]);
assert.deepEqual(base.rows.map((row) => row.enabled), [true, false, true]);
assert.deepEqual(base.rows.map((row) => row.fiberPhase), ["active", "pending", ""]);
assert.equal(base.disabled, 1);
assert.equal(graph.groups[1].enabled, false);
assert.equal(graph.groups[1].rows.length, 0);
assert.deepEqual(graph.presets, [{ name: "standard", rows: [{ moduleName: "x" }] }]);

// Missing sides degrade to empty lists instead of throwing.
const emptyGraph = pluginGraph(undefined, undefined);
assert.equal(emptyGraph.groups.length, 0);
assert.equal(emptyGraph.presets.length, 0);
assert.equal(emptyGraph.entries.length, 0);
const bareGraph = pluginGraph([{ name: "b" }], { entries: "nope" });
assert.equal(bareGraph.groups.length, 1);
assert.equal(bareGraph.groups[0].rows.length, 0);

console.log("feature-selftest: ok");
