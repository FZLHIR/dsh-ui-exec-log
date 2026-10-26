/**
 * Offline check for the installation-framework route in `index.js`.
 *
 * It builds a throwaway package root (`<tmp>\data\dsh` plus `APP`, `workspace`,
 * and one profile) and asserts the three projections the About page draws: the
 * named framework rows with their roles and sizes, the profile's composition,
 * and the plugin facts read through Host services (never a Client Remote).
 *
 * Run: node __layout-selftest.mjs
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internals__ } from "./index.js";

const { installRoot, scanTreeBounded, appVersion, profileNames, frameworkRows, compositionOf, pluginFacts, layoutOverview } = __internals__;

function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dsh-layout-selftest-"));
}

async function seed(root) {
  const home = path.join(root, "data", "dsh");
  await fs.mkdir(path.join(root, "APP", "resources", "app.asar", "dsh"), { recursive: true });
  await fs.writeFile(
    path.join(root, "APP", "resources", "app.asar", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "9.9.9-test" }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "DSH.cmd"), "@echo off\n", "utf8");
  await fs.mkdir(path.join(root, "workspace", "demo"), { recursive: true });
  await fs.writeFile(path.join(root, "workspace", "demo", "note.txt"), "hello", "utf8");
  await fs.mkdir(path.join(home, "profiles", "desktop"), { recursive: true });
  await fs.writeFile(
    path.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@local/x"] } } }),
    "utf8",
  );
  await fs.writeFile(
    path.join(home, "profiles", "desktop", "cordis.patch.yml"),
    "- id: llm-pi-ai\n  name: x\n- id: agent-default-model\n  name: y\n",
    "utf8",
  );
  await fs.mkdir(path.join(home, "sessions", "--slug--", "session-11111111-2222-3333-4444-555555555555"), { recursive: true });
  await fs.mkdir(path.join(home, "storages"), { recursive: true });
  await fs.writeFile(path.join(home, "AGENTS.md"), "# rules\n", "utf8");
  return home;
}

const root = await makeRoot();
const home = await seed(root);

// A portable install is recognised by `data` owning the home.
assert.equal(installRoot(home), root);
// A non-portable home is its own root: never widen to the user's home directory.
assert.equal(installRoot(path.join("C:", "Users", "someone", ".dsh")), path.join("C:", "Users", "someone", ".dsh"));

// The bounded scan reports what it counted and never follows links.
const scan = await scanTreeBounded(path.join(root, "workspace"));
assert.equal(scan.children, 1);
assert.equal(scan.files, 1);
assert.ok(scan.bytes >= 5);
assert.equal(scan.truncated, false);

// Framework rows: existing places only, named by role, sized where cheap.
const rows = await frameworkRows(home, "desktop", false);
const keys = rows.map((row) => row.key);
assert.deepEqual(keys, ["root", "launcher", "app", "runtime", "data", "home", "profiles", "profile", "sessions", "storages", "workspace"]);
const byKey = new Map(rows.map((row) => [row.key, row]));
assert.equal(byKey.get("root").kind, "dir");
assert.equal(byKey.get("root").depth, 0);
assert.equal(byKey.get("launcher").kind, "file");
assert.equal(byKey.get("launcher").bytes, 10);
assert.equal(byKey.get("profile").path, path.join(home, "profiles", "desktop"));
assert.equal(byKey.get("profile").depth, 4);
assert.ok(byKey.get("app").bytes > 0, "the app tree is sized");
assert.ok(byKey.get("home").bytes > 0, "the data home is sized");
assert.ok(byKey.get("workspace").bytes > 0, "the workspace is sized");
assert.equal(byKey.get("sessions").bytes, undefined, "only cheap sizes are collected");
assert.equal(typeof byKey.get("sessions").children, "number");

// Composition: bundles from the profile manifest, patch rows counted by id.
const composition = await compositionOf(home, "desktop");
assert.deepEqual(composition.bundles, ["@deepseek-ai/dsh-base", "@local/x"]);
assert.deepEqual(composition.patchIds, ["llm-pi-ai", "agent-default-model"]);
assert.equal(await compositionOf(home, ""), undefined);
assert.equal(await compositionOf(home, "missing"), undefined);

// Plugin facts come from Host services and are slimmed to what the page draws.
const ctx = {
  get(name) {
    if (name === "pluginInventory") {
      return {
        list: async () => ({
          entries: [
            { entryId: "e1", moduleName: "pkg-a", enabled: true, fiberPhase: "active", extra: "dropped" },
            { entryId: "e2", moduleName: "pkg-b", enabled: false, fiberPhase: "pending" },
          ],
          agentPresets: [{ name: "standard", rows: [{ moduleName: "x" }, { moduleName: "y" }] }],
        }),
      };
    }
    if (name === "pluginManager") {
      return {
        listBundles: async () => [
          {
            name: "@deepseek-ai/dsh-base",
            version: "1.2.3",
            source: "installation",
            enabled: true,
            rows: [{ rowId: "r1", moduleName: "pkg-a", entryId: "e1", config: { dropped: true } }],
            overrides: ["dropped"],
          },
        ],
      };
    }
    return undefined;
  },
};
const facts = await pluginFacts(ctx);
assert.equal(facts.error, "");
assert.deepEqual(facts.inventory.entries, [
  { entryId: "e1", moduleName: "pkg-a", enabled: true, fiberPhase: "active" },
  { entryId: "e2", moduleName: "pkg-b", enabled: false, fiberPhase: "pending" },
]);
assert.deepEqual(facts.inventory.presets, [{ name: "standard", rows: 2 }]);
assert.equal(facts.bundles[0].name, "@deepseek-ai/dsh-base");
assert.equal(facts.bundles[0].rows[0].moduleName, "pkg-a");
assert.equal(facts.bundles[0].overrides, undefined);

// A failing service is reported, not thrown.
const broken = await pluginFacts({
  get(name) {
    if (name === "pluginInventory") {
      return {
        list: async () => {
          throw new Error("nope");
        },
      };
    }
    return undefined;
  },
});
assert.equal(broken.error, "nope");
assert.equal(broken.inventory, undefined);
// No services at all is an empty answer, not a throw.
const empty = await pluginFacts({ get: () => undefined });
assert.equal(empty.error, "");
assert.equal(empty.bundles, undefined);

// The composed answer carries every projection.
const overview = await layoutOverview(ctx, home, true);
assert.equal(overview.root, root);
assert.equal(overview.home, home);
assert.equal(overview.app, true);
assert.equal(overview.version, "9.9.9-test");
assert.equal(overview.profile, "desktop");
assert.deepEqual(overview.profiles, ["desktop"]);
assert.equal(overview.rows.length, 11);
assert.equal(overview.composition.bundles.length, 2);
assert.equal(overview.plugins.bundles.length, 1);

// The plain version file is the fallback when the manifest is not JSON.
const bare = await makeRoot();
await fs.mkdir(path.join(bare, "APP"), { recursive: true });
await fs.writeFile(path.join(bare, "APP", "version"), "44.7.0\n", "utf8");
assert.equal(await appVersion(path.join(bare, "APP")), "44.7.0");
assert.equal(await appVersion(path.join(bare, "nope")), "");
assert.deepEqual(await profileNames(bare), []);

await fs.rm(root, { recursive: true, force: true });
await fs.rm(bare, { recursive: true, force: true });
console.log("layout selftest: ok");
