/**
 * Offline check for the installation-layout route in `index.js`.
 *
 * It builds a throwaway package root (`<tmp>\data\dsh` plus `APP`, `workspace`)
 * and asserts the two things the settings page depends on: a path can never
 * escape that root, and one level lists names, kinds, and sizes. The version
 * comes from a packaged manifest, so the manifest fixture is written as JSON.
 *
 * Run: node __layout-selftest.mjs
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internals__ } from "./index.js";

const { installRoot, insideRoot, listLayoutLevel, layoutOverview, scanTreeBounded, appVersion, profileNames } = __internals__;

function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dsh-layout-selftest-"));
}

async function seed(root) {
  const home = path.join(root, "data", "dsh");
  await fs.mkdir(path.join(root, "APP", "resources", "app.asar"), { recursive: true });
  await fs.writeFile(
    path.join(root, "APP", "resources", "app.asar", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "9.9.9-test" }),
    "utf8",
  );
  await fs.mkdir(path.join(root, "workspace", "demo"), { recursive: true });
  await fs.writeFile(path.join(root, "workspace", "demo", "note.txt"), "hello", "utf8");
  await fs.mkdir(path.join(home, "profiles", "desktop"), { recursive: true });
  await fs.mkdir(path.join(home, "sessions", "--slug--", "session-11111111-2222-3333-4444-555555555555"), { recursive: true });
  await fs.writeFile(path.join(home, "AGENTS.md"), "# rules\n", "utf8");
  return home;
}

const root = await makeRoot();
const home = await seed(root);

// A portable install is recognised by `data` owning the home.
assert.equal(installRoot(home), root);

// A non-portable home is its own root: the tree must never widen to the user's
// home directory just because `~/.dsh` sits under it.
assert.equal(installRoot(path.join("C:", "Users", "someone", ".dsh")), path.join("C:", "Users", "someone", ".dsh"));

// Path containment.
assert.equal(insideRoot(root, path.join(root, "APP")), path.join(root, "APP"));
assert.equal(insideRoot(root, root), root);
assert.equal(insideRoot(root, path.join(root, "..", "elsewhere")), undefined);
assert.equal(insideRoot(root, path.join(root, "APP", "..", "..", "escape")), undefined);
assert.equal(insideRoot(root, "D:\\Windows"), undefined);
assert.equal(insideRoot(root, ""), undefined);
assert.equal(insideRoot(root, undefined), undefined);

// A level lists directories first, then files, with directory sizes.
const level = await listLayoutLevel(root);
assert.deepEqual(level.entries.map((entry) => entry.name), ["APP", "data", "workspace"]);
assert.equal(level.more, 0);
assert.equal(level.total, 3);
const appEntry = level.entries[0];
assert.equal(appEntry.kind, "dir");
assert.equal(appEntry.children, 1);
assert.ok(appEntry.bytes > 0);
assert.equal(appEntry.truncated, false);

// One nested level keeps names and kinds.
const profilesLevel = await listLayoutLevel(path.join(root, "data", "dsh", "profiles"));
assert.deepEqual(profilesLevel.entries.map((entry) => entry.name), ["desktop"]);

// Files carry their own size and are never mistaken for directories.
const workspaceLevel = await listLayoutLevel(path.join(root, "workspace", "demo"));
assert.deepEqual(workspaceLevel.entries, [{ name: "note.txt", kind: "file", bytes: 5 }]);

// An unreadable or missing directory answers empty rather than throwing.
const missing = await listLayoutLevel(path.join(root, "nope"));
assert.equal(missing.error, "unreadable");
assert.deepEqual(missing.entries, []);

// The bounded scan reports what it counted and never claims more.
const scan = await scanTreeBounded(path.join(root, "workspace"));
assert.equal(scan.children, 1);
assert.equal(scan.files, 1);
assert.ok(scan.bytes >= 5);
assert.equal(scan.truncated, false);

// The overview carries version, profile, and per-directory totals.
const overview = await layoutOverview(home);
assert.equal(overview.root, root);
assert.equal(overview.home, home);
assert.equal(overview.app, true);
assert.equal(overview.version, "9.9.9-test");
assert.deepEqual(overview.profiles, ["desktop"]);
assert.equal(overview.profile, "desktop");
assert.ok(overview.totals.APP > 0);
assert.ok(overview.totals.workspace > 0);
assert.ok(overview.totals.data > 0);

// The plain version file is the fallback when the manifest is not JSON.
const bare = await makeRoot();
await fs.mkdir(path.join(bare, "APP"), { recursive: true });
await fs.writeFile(path.join(bare, "APP", "version"), "44.7.0\n", "utf8");
assert.equal(await appVersion(path.join(bare, "APP")), "44.7.0");
assert.equal(await appVersion(path.join(bare, "nope")), "");

// No profiles directory is an empty list, not a throw.
assert.deepEqual(await profileNames(bare), []);

await fs.rm(root, { recursive: true, force: true });
await fs.rm(bare, { recursive: true, force: true });
console.log("layout selftest: ok");
