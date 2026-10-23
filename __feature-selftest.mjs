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
  vm.runInNewContext(readFileSync("D:/P/DSH/workspace/plugins/dsh-ui-exec-log/client.js", "utf8"), sandbox, {
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
  "sidebar.workspaces.session.menu.item",
]);
assert.deepEqual(fake.tabTypes, []);

assert.deepEqual(names(), ["plugins.bundle.config", "settings.section", "sidebar.workspaces.session.menu.item"]);

// Session deletion off: the row menu entry leaves.
flags.set("sessionDelete", false);
assert.deepEqual(names(), ["plugins.bundle.config", "settings.section"]);

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
    "shell.overlay",
      "sidebar.right.pane.tab",
    "sidebar.right.pane.tab.title",
  ],
);

console.log("feature-selftest: ok");
