/**
 * Host half of the FZL toolkit (`@local/dsh-ui-exec-log`).
 *
 * The panels are drawn entirely by the browser half (`client.js`); this module
 * exists for the one operation a browser cannot perform: removing a Session's
 * durable data from disk.
 *
 * The Host owns no Remote endpoint we may call from plain JavaScript (Remote
 * methods are generated from TypeScript declarations), so the toolkit talks to
 * the Host over its own two small HTTP routes on the already-bound Web server:
 *
 *   GET  /fzl-toolkit/sessions         → { ok, home, sessions: [...] }
 *   POST /fzl-toolkit/sessions/delete  → { ok, removed, freedBytes, ... }
 *
 * Both answer only same-origin requests that carry the `x-fzl-toolkit` header,
 * which a cross-site page cannot add without a CORS preflight this server never
 * grants. The prefix deliberately avoids `/api`, which the RPC carrier owns.
 *
 * Deleting a Session is never just a file operation here. The Harness keeps
 * three separate views of it, and the sidebar survives a reload if any of them
 * still reports the Session:
 *
 *   1. `Context.sessions` - the in-memory Session Store. `session/list` unions
 *      its entries with the persisted records, so a resident Session keeps
 *      rendering after its files are gone.
 *   2. `Context.workspaceRegistry` - the durable Workspace records, held in
 *      memory and rewritten as a whole on every mutation. Editing
 *      `storages/workspace.json` behind it is invisible to the live Host and is
 *      overwritten by the next mutation.
 *   3. The JSONL log directory and its projection-cache row on disk.
 *
 * The delete route therefore unwinds all three in order, through the owning
 * services rather than through their files.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "/fzl-toolkit";
const ROUTE_LIST = PREFIX + "/sessions";
const ROUTE_DELETE = PREFIX + "/sessions/delete";
const ROUTE_TRANSLATE = PREFIX + "/translate";
const SESSION_DIR = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 8 * 1024;

/** The data root of this installation: the portable `DSH_HOME`, or the default. */
function dataHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return path.resolve(configured);
  return path.join(os.homedir(), ".dsh");
}

/** Read and parse one JSON file; a missing or broken file is `undefined`. */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    return undefined;
  }
}

/** Replace a JSON file atomically so a reader never observes a half-written unit. */
async function writeJsonAtomic(file, value) {
  const temporary = file + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, file);
}

/** Total bytes of one directory tree. */
async function treeBytes(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      try {
        total += (await fs.stat(child)).size;
      } catch (error) {
        // A file that vanished mid-scan contributes nothing.
      }
    }
  }
  return total;
}

/** Session identities the workspace registry knows, by id. */
async function registryIndex(home) {
  const registry = await readJson(path.join(home, "storages", "workspace.json"));
  const bySession = new Map();
  const archived = new Set();
  if (registry === undefined) return { bySession, archived };
  const global = registry.global;
  if (global !== null && typeof global === "object" && Array.isArray(global.archivedSessionIds)) {
    for (const id of global.archivedSessionIds) archived.add(id);
  }
  const tables = registry.tables;
  const workspaces = tables !== null && typeof tables === "object" ? tables.workspaces : undefined;
  if (workspaces !== null && typeof workspaces === "object") {
    for (const workspace of Object.values(workspaces)) {
      if (workspace === null || typeof workspace !== "object" || !Array.isArray(workspace.sessionIds)) continue;
      for (const id of workspace.sessionIds) {
        bySession.set(id, {
          path: typeof workspace.path === "string" ? workspace.path : "",
          title: typeof workspace.title === "string" ? workspace.title : "",
        });
      }
    }
  }
  return { bySession, archived };
}

/** Every Session directory on this Host, newest activity first. */
async function listSessions(home) {
  const root = path.join(home, "sessions");
  const cacheRoot = path.join(home, "storages", "session_projcache", "sessions");
  const { bySession, archived } = await registryIndex(home);
  let slugs;
  try {
    slugs = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const rows = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, slug.name), { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
      const directory = path.join(root, slug.name, entry.name);
      const stats = await fs.stat(directory).catch(() => undefined);
      const cache = await readJson(path.join(cacheRoot, entry.name + ".json"));
      const identity = cache !== undefined && cache.record !== undefined ? cache.record.identity : undefined;
      const titleRow = cache !== undefined && cache.record !== undefined ? cache.record.rows : undefined;
      const titleValue =
        titleRow !== undefined && titleRow !== null && titleRow.title !== undefined ? titleRow.title.val : undefined;
      const member = bySession.get(entry.name);
      rows.push({
        sessionId: entry.name,
        directory: directory,
        title: typeof titleValue === "string" ? titleValue : "",
        workspacePath: member === undefined ? "" : member.path,
        workspaceTitle: member === undefined ? "" : member.title,
        cwd: identity !== undefined && typeof identity.cwd === "string" ? identity.cwd : "",
        createdAt: identity !== undefined && typeof identity.createdAt === "number" ? identity.createdAt : 0,
        updatedAt: stats === undefined ? 0 : stats.mtimeMs,
        bytes: await treeBytes(directory),
        archived: archived.has(entry.name),
      });
    }
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt);
  return rows;
}

/**
 * Forget one Session in the workspace registry.
 *
 * The registry exposes no removal method (only archive), so the durable unit is
 * edited in place: the Session disappears from both the workspace row list and
 * the archived list, which is what makes it stop rendering once its directory
 * is gone.
 */
async function forgetInRegistry(file, sessionId) {
  const registry = await readJson(file);
  if (registry === undefined) return false;
  const global = registry.global;
  const tables = registry.tables;
  const workspaces = tables !== null && typeof tables === "object" ? tables.workspaces : undefined;
  let changed = false;
  const drop = (list) => {
    if (!Array.isArray(list)) return list;
    const next = list.filter((id) => id !== sessionId);
    if (next.length !== list.length) changed = true;
    return next;
  };
  if (global !== null && typeof global === "object" && Array.isArray(global.archivedSessionIds)) {
    global.archivedSessionIds = drop(global.archivedSessionIds);
    if (Array.isArray(global.pinnedSessionIds)) global.pinnedSessionIds = drop(global.pinnedSessionIds);
  }
  if (workspaces !== null && typeof workspaces === "object") {
    for (const workspace of Object.values(workspaces)) {
      if (workspace === null || typeof workspace !== "object") continue;
      if (Array.isArray(workspace.sessionIds)) workspace.sessionIds = drop(workspace.sessionIds);
    }
  }
  if (!changed) return false;
  await writeJsonAtomic(file, registry);
  return true;
}

/** Resolve one optional Host service; a partial composition simply has fewer. */
function service(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch (error) {
    return undefined;
  }
}

/**
 * Stop the work a resident Agent still runs, without taking its lifecycle.
 *
 * The Agent's teardown handle belongs to the Session Controller, which created
 * it and never exposes it; a third-party plugin cannot dispose it. Cancelling
 * the running turn is the part we can do, and it is required before the files
 * go: a turn that settles after the deletion would write its closing events and
 * recreate a headerless log. The loop reports `status` and settles quickly once
 * its abort signal fires, so the wait is bounded by a short grace period rather
 * than by the tool the turn was running.
 */
async function quiesceLiveAgent(ctx, sessionId, timeoutMs = 4000) {
  const agents = service(ctx, "agents");
  if (agents === undefined || typeof agents.get !== "function") return false;
  let agent;
  try {
    agent = agents.get(sessionId);
  } catch (error) {
    return false;
  }
  if (agent === undefined || agent === null) return false;
  try {
    if (typeof agent.cancel === "function") agent.cancel({ kind: "disposed" }, { keepInbox: true });
  } catch (error) {
    // An idle Agent accepts the cancel as a no-op; a closed one needs nothing.
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status;
    try {
      status = agent.status;
    } catch (error) {
      break;
    }
    if (status === undefined || status === "idle") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Drop one Agent from the live registry.
 *
 * Removing the entry is the same edge the owning teardown uses: it emits
 * `agent/disposed` and stops every later availability update from naming a
 * Session that no longer exists. The loop object itself stays owned by the
 * Session Controller, which is exactly the ownership this plugin must not take.
 */
function forgetLiveAgent(ctx, sessionId) {
  const agents = service(ctx, "agents");
  if (agents === undefined || typeof agents.detachEntered !== "function") return false;
  const store = agents.store;
  if (store === undefined || store === null || typeof store.get !== "function") return false;
  const entry = store.get(sessionId);
  if (entry === undefined) return false;
  agents.detachEntered(entry);
  return true;
}

/**
 * Drop one Session from the in-memory Session Store.
 *
 * `SessionStore` exposes no removal verb. A Session normally leaves through the
 * detach disposer its creating fiber yields, and a resident Agent keeps that
 * disposer private. The Store does hold each entered entry in `store`, and
 * `detachEntered` is the exact teardown that disposer runs: store removal,
 * attachment release, and one `session/disposed` announcement - which the
 * Session Controller turns into `api-session/removed` for every connected
 * Client. This is the difference between "the file was deleted" and "the
 * Session is gone": `session/list` unions stored records with
 * `ctx.sessions.list()`, so a Session left here keeps rendering after a reload.
 */
function forgetLiveSession(ctx, sessionId) {
  const sessions = service(ctx, "sessions");
  if (sessions === undefined || typeof sessions.detachEntered !== "function") return false;
  const store = sessions.store;
  if (store === undefined || store === null || typeof store.get !== "function") return false;
  const entry = store.get(sessionId);
  if (entry === undefined) return false;
  sessions.detachEntered(entry);
  return true;
}

/**
 * Forget one Session in the live Workspace registry.
 *
 * The registry keeps every record in memory and rewrites the whole domain
 * global on each mutation, so editing `storages/workspace.json` behind its back
 * is invisible to the running Host and is overwritten by the next write.
 * Detaching through the entity is the supported path: it updates the durable
 * record, and the Workspace feed turns the domain change into one `upsert`
 * frame, so the row leaves the sidebar immediately and stays gone after a
 * reload. Unarchive and unpin are part of the same teardown: an archived id
 * would otherwise keep the Session in the archived list.
 */
async function forgetMembership(ctx, sessionId) {
  const report = { used: false, workspaces: 0, unarchived: false, unpinned: false };
  const registry = service(ctx, "workspaceRegistry");
  if (registry === undefined || typeof registry.list !== "function") return report;
  report.used = true;
  for (const workspace of registry.list()) {
    if (workspace === undefined || workspace === null) continue;
    const record = workspace.record;
    const ids = record !== undefined && record !== null && Array.isArray(record.sessionIds) ? record.sessionIds : workspace.sessionIds;
    const accounted = Array.isArray(ids) && ids.includes(sessionId);
    const visible = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
    if (!accounted && !visible) continue;
    await workspace.detachSession(sessionId);
    report.workspaces += 1;
  }
  if (Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)) {
    await registry.unarchiveSession(sessionId);
    report.unarchived = true;
  }
  if (Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(sessionId)) {
    await registry.unpinSession(sessionId);
    report.unpinned = true;
  }
  return report;
}

/**
 * Forget Workspace members whose Session is neither stored nor healthy.
 *
 * The registry never re-derives membership after its one bootstrap, so a Session
 * deleted by an earlier build leaves its id in the durable record forever. Two
 * kinds of residue are repaired here:
 *
 *   - a member that is neither live nor stored is dropped from the record;
 *   - a member that is still live but whose log is gone (a ghost left by a file
 *     deletion that skipped the in-memory store) is detached and its Agent
 *     registration released, because nothing durable remains to preserve.
 *
 * Both cases are invisible to the sidebar until they are gone, and both come
 * back after a reload if left alone.
 */
async function pruneDeadMembers(ctx) {
  const registry = service(ctx, "workspaceRegistry");
  const persistence = service(ctx, "sessionPersistence");
  if (registry === undefined || typeof registry.list !== "function") return [];
  if (persistence === undefined || typeof persistence.stat !== "function") return [];
  const sessions = service(ctx, "sessions");
  const live = new Set(typeof sessions?.list === "function" ? sessions.list().map((session) => session.id) : []);
  const stored = async (sessionId) => {
    try {
      return (await persistence.stat(sessionId)) !== undefined;
    } catch (error) {
      return true; // A failing stat never proves the Session absent.
    }
  };
  const pruned = [];
  const ghost = async (sessionId) => {
    if (!live.has(sessionId)) return;
    if (await stored(sessionId)) return;
    if (forgetLiveSession(ctx, sessionId)) forgetLiveAgent(ctx, sessionId);
    live.delete(sessionId);
    pruned.push(sessionId);
  };
  const drop = async (sessionId) => {
    forgetLiveAgent(ctx, sessionId);
    for (const workspace of registry.list()) {
      if (workspace === undefined || workspace === null) continue;
      const record = workspace.record;
      const ids = record !== undefined && record !== null && Array.isArray(record.sessionIds) ? record.sessionIds : [];
      if (ids.includes(sessionId)) await workspace.detachSession(sessionId);
    }
    if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId);
    if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId);
  };
  const candidates = new Set();
  for (const workspace of registry.list()) {
    if (workspace === undefined || workspace === null) continue;
    const record = workspace.record;
    if (record !== undefined && record !== null && Array.isArray(record.sessionIds)) {
      for (const sessionId of record.sessionIds) candidates.add(sessionId);
    }
  }
  for (const sessionId of registry.archivedSessionIds) candidates.add(sessionId);
  for (const sessionId of registry.pinnedSessionIds) candidates.add(sessionId);
  for (const sessionId of candidates) {
    await ghost(sessionId);
    if (live.has(sessionId)) continue; // A healthy live Session keeps its membership.
    if (await stored(sessionId)) continue;
    await drop(sessionId);
    if (!pruned.includes(sessionId)) pruned.push(sessionId);
  }
  return pruned;
}

/** Remove one Session's directory and its projection-cache rows from disk. */
async function removeSessionFiles(home, sessionId) {
  const removed = [];
  let freedBytes = 0;
  const root = path.join(home, "sessions");
  let slugs = [];
  try {
    slugs = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    slugs = [];
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDirectory = path.join(root, slug.name);
    const directory = path.join(slugDirectory, sessionId);
    const stats = await fs.stat(directory).catch(() => undefined);
    if (stats === undefined) continue;
    freedBytes += await treeBytes(directory);
    await fs.rm(directory, { recursive: true, force: true });
    removed.push(directory);
    const remaining = await fs.readdir(slugDirectory).catch(() => []);
    if (remaining.length === 0) await fs.rmdir(slugDirectory).catch(() => undefined);
  }
  const cacheDirectory = path.join(home, "storages", "session_projcache", "sessions");
  let cacheNames = [];
  try {
    cacheNames = await fs.readdir(cacheDirectory);
  } catch (error) {
    cacheNames = [];
  }
  for (const name of cacheNames) {
    if (name !== sessionId + ".json" && name !== sessionId + ".json.tmp") continue;
    const file = path.join(cacheDirectory, name);
    const stats = await fs.stat(file).catch(() => undefined);
    if (stats !== undefined) freedBytes += stats.size;
    await fs.rm(file, { force: true });
    removed.push(file);
  }
  return { removed, freedBytes };
}

/**
 * Delete one Session everywhere the Harness can still see it.
 *
 * Order matters, because the pieces observe each other:
 *
 *   1. A resident Agent is cancelled first and awaited until idle. Its settled
 *      turn writes a last batch of durable events, so the deletion waits one
 *      write window before touching the directory; otherwise a late batch
 *      recreates the log.
 *   2. The files go next, so a lock or permission failure aborts with the
 *      Session itself still consistent and reported.
 *   3. The in-memory Session and its Agent registration leave, which is what
 *      makes `session/list` - persisted records unioned with live Sessions -
 *      stop reporting the row after a reload.
 *   4. Workspace membership, the archive set, and the pin set are released
 *      through the registry, which pushes the Sidebar update immediately.
 */
async function removeSession(ctx, home, sessionId) {
  const report = {
    sessionId,
    removed: [],
    freedBytes: 0,
    live: false,
    agent: false,
    workspaces: 0,
    unarchived: false,
    unpinned: false,
    registryUpdated: false,
    pruned: [],
  };
  report.agent = await quiesceLiveAgent(ctx, sessionId);
  // One write window after the settled turn, so its last batch reaches the log
  // before the directory is unlinked.
  if (report.agent) await new Promise((resolve) => setTimeout(resolve, 200));
  const files = await removeSessionFiles(home, sessionId);
  report.removed = files.removed;
  report.freedBytes = files.freedBytes;
  report.live = forgetLiveSession(ctx, sessionId);
  report.agent = forgetLiveAgent(ctx, sessionId) || report.agent;
  const membership = await forgetMembership(ctx, sessionId);
  report.workspaces = membership.workspaces;
  report.unarchived = membership.unarchived;
  report.unpinned = membership.unpinned;
  report.registryUpdated = membership.used
    ? true
    : await forgetInRegistry(path.join(home, "storages", "workspace.json"), sessionId);
  if (!report.live && typeof ctx.emit === "function") {
    try {
      // A cold Session leaves no `session/disposed` behind; announce the removal
      // so an already-connected Client drops the row instead of keeping a stale one.
      ctx.emit("api-session/removed", sessionId);
    } catch (error) {
      // A listener failure never turns a completed deletion into a failed one.
    }
  }
  report.pruned = await pruneDeadMembers(ctx);
  return report;
}

/* ------------------------------------------------------------------ *
 * The installation framework: what this DSH is made of, and where.
 *
 * This is not a file browser. It names the handful of places one install
 * always has - the launcher, the app, the harness runtime, the data home,
 * the profile, the session log, the workspace - and says what each one is
 * for, with a size where a size is cheap to learn. The plugin pane comes
 * from the Host's own services, not from a Client Remote the plugin may
 * not be allowed to call.
 * ------------------------------------------------------------------ */

const ROUTE_LAYOUT = PREFIX + "/layout";
const LAYOUT_SCAN_BUDGET_MS = 600;
const LAYOUT_SCAN_MAX_ENTRIES = 20000;
const LAYOUT_CACHE_MS = 20000;

/** Directory scans, keyed by absolute path; sizes are the expensive part. */
const layoutScans = new Map();
/** The composed answer, reused for `LAYOUT_CACHE_MS`. */
let layoutComposed;

/** The installation root that owns this data home. */
function installRoot(home) {
  const parent = path.dirname(home);
  if (path.basename(parent).toLowerCase() === "data") return path.dirname(parent);
  return home;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Total bytes of one tree under a time and entry budget.
 *
 * Symlinks are counted as entries but never followed: a pnpm profile links
 * its packages into `.pnpm`, and following those would count the same files
 * more than once - or forever, on a cycle.
 */
async function scanTreeBounded(directory) {
  const deadline = Date.now() + LAYOUT_SCAN_BUDGET_MS;
  let bytes = 0;
  let files = 0;
  let children = 0;
  let visited = 0;
  let truncated = false;
  const stack = [directory];
  while (stack.length > 0 && truncated === false) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    if (current === directory) children = entries.length;
    for (const entry of entries) {
      visited += 1;
      if (visited > LAYOUT_SCAN_MAX_ENTRIES || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      try {
        bytes += (await fs.stat(child)).size;
        files += 1;
      } catch (error) {
        // A link to a vanished target, or a file we may not stat, is skipped.
      }
    }
  }
  return { bytes, files, children, truncated };
}

/** One directory scan, reused for `LAYOUT_CACHE_MS`. */
async function scanTreeCached(directory, refresh) {
  const now = Date.now();
  const cached = layoutScans.get(directory);
  if (refresh !== true && cached !== undefined && now - cached.at < LAYOUT_CACHE_MS) return cached.value;
  if (layoutScans.size > 400) layoutScans.clear();
  const value = await scanTreeBounded(directory);
  layoutScans.set(directory, { at: now, value });
  return value;
}

/** This installation's version, from the packaged manifest. */
async function appVersion(appRoot) {
  const manifest = path.join(appRoot, "resources", "app.asar", "package.json");
  const candidates = [manifest, path.join(appRoot, "version")];
  for (const file of candidates) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      continue;
    }
    if (file === manifest) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.version === "string" && parsed.version !== "") return parsed.version;
      } catch (error) {
        // A manifest that is not JSON falls through to the plain version file.
      }
      continue;
    }
    const trimmed = text.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** The profile directories this Home holds, `desktop` first when present. */
async function profileNames(home) {
  let dirents;
  try {
    dirents = await fs.readdir(path.join(home, "profiles"), { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const names = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  names.sort((left, right) => (left === right ? 0 : left === "desktop" ? -1 : right === "desktop" ? 1 : left.localeCompare(right)));
  return names;
}

/**
 * The named places one installation is made of.
 *
 * `depth` is the drawing indent, not the disk depth: `data\dsh` sits two
 * levels down but is described under `data` so the picture stays readable.
 */
function frameworkPlan(home, profile) {
  const root = installRoot(home);
  const app = path.join(root, "APP");
  const data = path.dirname(home);
  const profiles = path.join(home, "profiles");
  const rows = [
    { key: "root", path: root, depth: 0, role: "root", parent: "" },
    { key: "launcher", path: path.join(root, "DSH.cmd"), depth: 1, role: "launcher", parent: "root" },
    { key: "app", path: app, depth: 1, role: "app", parent: "root" },
    { key: "runtime", path: path.join(app, "resources", "app.asar", "dsh"), depth: 2, role: "runtime", parent: "app" },
    { key: "data", path: data, depth: 1, role: "data", parent: "root" },
    { key: "home", path: home, depth: 2, role: "home", parent: "data" },
    { key: "profiles", path: profiles, depth: 3, role: "profiles", parent: "home" },
    { key: "sessions", path: path.join(home, "sessions"), depth: 3, role: "sessions", parent: "home" },
    { key: "storages", path: path.join(home, "storages"), depth: 3, role: "storages", parent: "home" },
    { key: "attachments", path: path.join(home, "attachments"), depth: 3, role: "attachments", parent: "home" },
    { key: "runtimes", path: path.join(home, "dsh-runtimes"), depth: 3, role: "runtimes", parent: "home" },
    { key: "workspace", path: path.join(root, "workspace"), depth: 1, role: "workspace", parent: "root" },
  ];
  if (profile !== "") {
    rows.splice(7, 0, { key: "profile", path: path.join(profiles, profile), depth: 4, role: "profile", parent: "profiles" });
  }
  return rows;
}

/** The framework rows that exist on this disk, with a size where it is cheap. */
async function frameworkRows(home, profile, refresh) {
  const sized = new Set(["app", "home", "workspace"]);
  const rows = [];
  for (const row of frameworkPlan(home, profile)) {
    if ((await exists(row.path)) !== true) continue;
    const directory = await isDirectory(row.path);
    const entry = {
      key: row.key,
      path: row.path,
      depth: row.depth,
      role: row.role,
      parent: row.parent,
      kind: directory ? "dir" : "file",
    };
    if (directory) {
      try {
        entry.children = (await fs.readdir(row.path, { withFileTypes: true })).length;
      } catch (error) {
        entry.children = 0;
      }
      if (sized.has(row.key)) {
        const scan = await scanTreeCached(row.path, refresh);
        entry.bytes = scan.bytes;
        entry.truncated = scan.truncated;
      }
    } else {
      try {
        entry.bytes = (await fs.stat(row.path)).size;
      } catch (error) {
        entry.bytes = 0;
      }
    }
    rows.push(entry);
  }
  return rows;
}

/** Which bundles and patch rows this profile is composed from. */
async function compositionOf(home, profile) {
  if (profile === "") return undefined;
  const directory = path.join(home, "profiles", profile);
  if ((await isDirectory(directory)) !== true) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  } catch (error) {
    manifest = undefined;
  }
  const profileSpec = manifest !== undefined && manifest.dsh !== undefined ? manifest.dsh.profile : undefined;
  const bundles = profileSpec !== undefined && Array.isArray(profileSpec.bundles) ? profileSpec.bundles.filter((name) => typeof name === "string") : [];
  let patchIds = [];
  try {
    const patch = await fs.readFile(path.join(directory, "cordis.patch.yml"), "utf8");
    patchIds = [...patch.matchAll(/^-\s+id:\s*(\S+)/gm)].map((match) => match[1]);
  } catch (error) {
    patchIds = [];
  }
  return { profile, bundles, patchIds };
}

/** One display metadata record, reduced to the two fields the page shows. */
function metaFacts(meta) {
  if (meta === null || meta === undefined || typeof meta !== "object") return undefined;
  const result = {};
  if (meta.title !== undefined) result.title = meta.title;
  if (meta.description !== undefined) result.description = meta.description;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** The Loader's live entries plus the profile's bundles, read through Host services. */
async function pluginFacts(ctx) {
  const inventoryService = service(ctx, "pluginInventory");
  const manager = service(ctx, "pluginManager");
  const facts = { error: "" };
  try {
    if (inventoryService !== undefined && typeof inventoryService.list === "function") {
      const inventory = await inventoryService.list();
      facts.inventory = {
        entries: (Array.isArray(inventory.entries) ? inventory.entries : []).map((entry) => {
          const meta = metaFacts(entry.meta);
          return {
            entryId: typeof entry.entryId === "string" ? entry.entryId : "",
            moduleName: typeof entry.moduleName === "string" ? entry.moduleName : "",
            enabled: entry.enabled !== false,
            fiberPhase: typeof entry.fiberPhase === "string" ? entry.fiberPhase : "",
            ...(meta === undefined ? {} : { meta }),
          };
        }),
        presets: (Array.isArray(inventory.agentPresets) ? inventory.agentPresets : []).map((preset) => ({
          name: typeof preset.name === "string" ? preset.name : typeof preset.id === "string" ? preset.id : "",
          rows: (Array.isArray(preset.rows) ? preset.rows : []).length,
        })),
      };
    }
  } catch (error) {
    facts.error = String(error !== undefined && error !== null && error.message !== undefined ? error.message : error);
  }
  try {
    if (manager !== undefined && typeof manager.listBundles === "function") {
      const bundles = await manager.listBundles();
      facts.bundles = (Array.isArray(bundles) ? bundles : []).map((bundle) => {
        const meta = metaFacts(bundle.meta);
        return {
          name: typeof bundle.name === "string" ? bundle.name : "",
          version: typeof bundle.version === "string" ? bundle.version : "",
          source: typeof bundle.source === "string" ? bundle.source : "",
          availability: typeof bundle.availability === "string" ? bundle.availability : "",
          enabled: bundle.enabled === true,
          error: bundle.error !== undefined && bundle.error !== null ? String(bundle.error.code === undefined ? bundle.error : bundle.error.code) : "",
          ...(meta === undefined ? {} : { meta }),
          rows: (Array.isArray(bundle.rows) ? bundle.rows : []).map((row) => {
            const rowMeta = metaFacts(row.meta);
            return {
              rowId: typeof row.rowId === "string" ? row.rowId : "",
              moduleName: typeof row.moduleName === "string" ? row.moduleName : "",
              entryId: typeof row.entryId === "string" ? row.entryId : "",
              ...(rowMeta === undefined ? {} : { meta: rowMeta }),
            };
          }),
        };
      });
    }
  } catch (error) {
    if (facts.error === "") facts.error = String(error !== undefined && error !== null && error.message !== undefined ? error.message : error);
  }
  return facts;
}

/** The whole picture: paths, version, profile, framework rows, composition, plugins. */
async function layoutOverview(ctx, home, refresh) {
  const root = installRoot(home);
  const appRoot = path.join(root, "APP");
  const app = await isDirectory(appRoot);
  const profiles = await profileNames(home);
  const profile = profiles.length > 0 ? profiles[0] : "";
  return {
    root,
    home,
    app,
    version: await appVersion(app ? appRoot : root),
    profiles,
    profile,
    rows: await frameworkRows(home, profile, refresh),
    composition: await compositionOf(home, profile),
    plugins: await pluginFacts(ctx),
  };
}

/** Answer one request with JSON. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Same-origin check.
 *
 * A browser sends `Origin` on cross-site and on POST requests, so an origin that
 * does not match the Host it reached is rejected; a same-origin GET may omit it
 * and is accepted. The custom header keeps cross-site pages out even when they
 * manage to send a simple request.
 */
function admitted(req) {
  if (req.headers["x-fzl-toolkit"] !== "1") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

/** Read a bounded JSON request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Wait for the browser HTTP carrier before mounting.
 *
 * `apply` used to read `ctx.get("webServer")` immediately and bail out when the
 * service was not available yet. On a cold boot the entry is composed before the
 * webserver row settles, so the early return skipped every route registration:
 * the panel then reported the Host half as missing ("restart DSH"), and a restart
 * reproduced the same skip instead of fixing it. Declaring the dependency makes
 * Cordis hold this plugin until the service exists.
 */
export const inject = ["webServer"];

/** The Host half: two read/write routes over the Session store. */
export function apply(ctx) {
  // Defensive: with `inject` above this is only reachable in a composition that
  // provides no browser carrier at all, where a silent return is the right answer.
  const server = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  if (server === undefined || server === null) return;
  const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;

  const isLive = (sessionId) => {
    if (agents === undefined || agents === null || typeof agents.get !== "function") return false;
    try {
      return agents.get(sessionId) !== undefined;
    } catch (error) {
      return false;
    }
  };

  // Repair residue from deletions made before the in-memory unwind existed: the
  // registry keeps membership forever, so a ghost row would otherwise survive
  // every reload. Running once after startup settles keeps that repair invisible.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      pruneDeadMembers(ctx).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, "fzl-toolkit: prune dead members");

  ctx.effect(
    () =>
      server.register({
        kind: "exact",
        path: ROUTE_LIST,
        handler: async (req, res) => {
          if (!admitted(req)) {
            sendJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          const home = dataHome();
          try {
            const pruned = await pruneDeadMembers(ctx).catch(() => []);
            const sessions = await listSessions(home);
            const memory = service(ctx, "sessions");
            sendJson(res, 200, {
              ok: true,
              revision: 2,
              home: home,
              pruned: pruned,
              // Ids the Host still holds in memory: a row here with no directory
              // is a ghost, and the delete route is what clears it.
              resident:
                memory === undefined || typeof memory.list !== "function"
                  ? []
                  : memory.list().map((session) => String(session.id)),
              sessions: sessions.map((row) => ({ ...row, live: isLive(row.sessionId) })),
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        },
      }),
    "fzl-toolkit: sessions route",
  );

  ctx.effect(
    () =>
      server.register({
        kind: "exact",
        path: ROUTE_DELETE,
        handler: async (req, res) => {
          if (!admitted(req)) {
            sendJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          let request;
          try {
            request = JSON.parse(await readBody(req));
          } catch (error) {
            sendJson(res, 400, { ok: false, error: "bad-request" });
            return;
          }
          const sessionId = request !== null && typeof request === "object" ? request.sessionId : undefined;
          if (typeof sessionId !== "string" || !SESSION_DIR.test(sessionId)) {
            sendJson(res, 400, { ok: false, error: "bad-session-id" });
            return;
          }
          // Deleting a resident Session is supported: its files, its in-memory
          // store entry, its Agent registration, and its Workspace membership are
          // all released, because any one of them left behind would bring the row
          // back after a reload. A path the operating system still refuses answers
          // `session-busy` instead of pretending to succeed.
          try {
            const result = await removeSession(ctx, dataHome(), sessionId);
            sendJson(res, 200, {
              ok: true,
              sessionId: sessionId,
              removed: result.removed,
              freedBytes: result.freedBytes,
              registryUpdated: result.registryUpdated,
              live: result.live,
              agent: result.agent,
              workspaces: result.workspaces,
              unarchived: result.unarchived,
              unpinned: result.unpinned,
              pruned: result.pruned,
            });
          } catch (error) {
            const reason = String(error && error.message ? error.message : error);
            const locked =
              error !== null &&
              error !== undefined &&
              (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES");
            sendJson(res, locked ? 409 : 500, { ok: false, error: locked ? "session-busy" : reason });
          }
        },
      }),
    "fzl-toolkit: delete route",
  );

  // The installation framework: the settings page asks once and draws the
  // picture. Sizes and the plugin list are cached briefly, so reopening the
  // page is free and `refresh=1` is the explicit rescan.
  ctx.effect(
    () =>
      server.register({
        kind: "exact",
        path: ROUTE_LAYOUT,
        handler: async (req, res) => {
          if (!admitted(req)) {
            sendJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          let url;
          try {
            url = new URL(req.url === undefined ? ROUTE_LAYOUT : req.url, "http://dsh.local");
          } catch (error) {
            sendJson(res, 400, { ok: false, error: "bad-request" });
            return;
          }
          if (url.searchParams.get("refresh") === "1") {
            layoutScans.clear();
            layoutComposed = undefined;
          }
          const now = Date.now();
          if (layoutComposed !== undefined && now - layoutComposed.at < LAYOUT_CACHE_MS) {
            sendJson(res, 200, { ok: true, revision: 2, ...layoutComposed.value });
            return;
          }
          try {
            const value = await layoutOverview(ctx, dataHome(), false);
            layoutComposed = { at: Date.now(), value };
            sendJson(res, 200, { ok: true, revision: 2, ...value });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        },
      }),
    "fzl-toolkit: layout route",
  );

  // Translation through the Host translator service: a text already translated
  // for this Session comes from its durable cache, so the panel pays nothing for
  // reasoning the reader has already expanded.
  ctx.effect(
    () =>
      server.register({
        kind: "exact",
        path: ROUTE_TRANSLATE,
        handler: async (req, res) => {
          if (!admitted(req)) {
            sendJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          try {
            const translator = ctx.get("translator");
            if (translator === undefined || translator === null) {
              sendJson(res, 503, { ok: false, error: "translator-unavailable" });
              return;
            }
            const input = JSON.parse(await readBody(req));
            const text = typeof input.text === "string" ? input.text : "";
            if (text === "") {
              sendJson(res, 400, { ok: false, error: "empty-text" });
              return;
            }
            const request = { text, targetLanguage: "zh-CN" };
            if (typeof input.sessionId === "string" && input.sessionId !== "") request.sessionId = input.sessionId;
            const spec = translator.resolve(request);
            const translated = await translator.translate(spec);
            sendJson(res, 200, { ok: true, text: translated });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error && error.code ? error.code : error && error.message ? error.message : error) });
          }
        },
      }),
    "fzl-toolkit: translate route",
  );


}

/** Internals exported so the Host logic can be exercised outside the Loader. */
export const __internals__ = {
  dataHome,
  installRoot,
  scanTreeBounded,
  appVersion,
  profileNames,
  frameworkRows,
  compositionOf,
  pluginFacts,
  layoutOverview,
  listSessions,
  removeSession,
  removeSessionFiles,
  forgetInRegistry,
  forgetMembership,
  forgetLiveSession,
  forgetLiveAgent,
  pruneDeadMembers,
  quiesceLiveAgent,
  registryIndex,
  treeBytes,
};
