/**
 * Offline check for the Session delete pipeline in `index.js`.
 *
 * It builds a throwaway DSH home plus fake Host services that mirror the real
 * shapes this plugin touches (SessionStore.store/entry, Agent registry store,
 * the Workspace registry entity API, and the JSONL persistence `stat`), then
 * asserts that `removeSession` unwinds every layer exactly once.
 *
 * Run: node __delete-selftest.mjs
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internals__ } from "./index.js";

const { removeSession } = __internals__;

const SESSION_ID = "session-11111111-2222-3333-4444-555555555555";
const SLUG = "--tmp-workspace--";
const DEAD_ID = "session-99999999-8888-7777-6666-555555555555";

function makeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dsh-delete-selftest-"));
}

async function seed(home) {
  const dir = path.join(home, "sessions", SLUG, SESSION_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "session.v4.jsonl"), '{"header":true}\n', "utf8");
  await fs.writeFile(path.join(dir, "session.v4.meta.json"), "{}", "utf8");
  const cacheDir = path.join(home, "storages", "session_projcache", "sessions");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, SESSION_ID + ".json"), '{"record":{}}', "utf8");
  const registry = {
    unit: { name: "workspace", version: 2 },
    global: {
      initialized: true,
      workspaceIds: ["ws-1"],
      archivedSessionIds: [SESSION_ID],
      pinnedSessionIds: [SESSION_ID],
    },
    tables: {
      workspaces: {
        "ws-1": {
          path: "C:\\tmp\\workspace",
          title: "workspace",
          sessionIds: [SESSION_ID, DEAD_ID],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  };
  await fs.writeFile(path.join(home, "storages", "workspace.json"), JSON.stringify(registry, null, 2), "utf8");
  return dir;
}

function fakeContext(home, options = {}) {
  const events = [];
  const calls = { detachedSessions: [], detachedAgents: [], detachedMembers: [], unarchive: [], unpin: [], moved: [] };
  const liveSessions = new Map();
  const liveAgents = new Map();
  liveSessions.set(SESSION_ID, { id: SESSION_ID });
  liveAgents.set(SESSION_ID, { id: SESSION_ID, cancel: () => calls.moved.push("cancel") });

  const workspace = {
    id: "ws-1",
    record: { sessionIds: [SESSION_ID, DEAD_ID] },
    get sessionIds() {
      return this.record.sessionIds;
    },
    async detachSession(id) {
      calls.detachedMembers.push(id);
      this.record.sessionIds = this.record.sessionIds.filter((candidate) => candidate !== id);
    },
  };
  const state = { archivedSessionIds: [...(options.archived ?? [SESSION_ID])], pinnedSessionIds: [...(options.pinned ?? [SESSION_ID])] };
  const registry = {
    get archivedSessionIds() {
      return state.archivedSessionIds;
    },
    get pinnedSessionIds() {
      return state.pinnedSessionIds;
    },
    list: () => [workspace],
    async unarchiveSession(id) {
      calls.unarchive.push(id);
      state.archivedSessionIds = state.archivedSessionIds.filter((candidate) => candidate !== id);
    },
    async unpinSession(id) {
      calls.unpin.push(id);
      state.pinnedSessionIds = state.pinnedSessionIds.filter((candidate) => candidate !== id);
    },
  };
  const sessions = {
    store: liveSessions,
    list: () => [...liveSessions.values()],
    detachEntered(entry) {
      calls.detachedSessions.push(entry.id);
      this.store.delete(entry.id);
    },
  };
  const agents = {
    store: liveAgents,
    get: (id) => liveAgents.get(id),
    detachEntered(entry) {
      calls.detachedAgents.push(entry.id);
      this.store.delete(entry.id);
    },
  };
  const persistence = {
    async stat(id) {
      if (id === SESSION_ID) return undefined; // the log was just unlinked
      if (id === DEAD_ID) return undefined;
      return { header: { id } };
    },
  };
  const services = { sessions, agents, workspaceRegistry: registry, sessionPersistence: persistence };
  const ctx = {
    get: (name) => services[name],
    emit: (name, payload) => events.push([name, payload]),
  };
  return { ctx, calls, events, liveSessions, liveAgents, workspace };
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    return false;
  }
}

// 1. Full unwind with a resident Session and a live registry.
{
  const home = await makeHome();
  const dir = await seed(home);
  const fake = fakeContext(home);
  const report = await removeSession(fake.ctx, home, SESSION_ID);
  assert.equal(await exists(dir), false, "Session directory is removed");
  assert.equal(await exists(path.join(home, "storages", "session_projcache", "sessions", SESSION_ID + ".json")), false, "projection cache is removed");
  assert.deepEqual(fake.calls.detachedSessions, [SESSION_ID], "resident Session is detached once");
  assert.deepEqual(fake.calls.detachedAgents, [SESSION_ID], "Agent registration is removed once");
  assert.equal(fake.calls.moved.includes("cancel"), true, "running turn is cancelled");
  assert.equal(report.live, true, "report marks the Session live");
  assert.equal(report.workspaces, 1, "one Workspace membership released");
  assert.equal(report.unarchived, true, "archive membership released");
  assert.equal(report.unpinned, true, "pin membership released");
  assert.equal(fake.workspace.record.sessionIds.includes(SESSION_ID), false, "membership slot dropped");
  assert.equal(report.registryUpdated, true, "registry path used, not the file rewrite");
  assert.deepEqual(report.pruned, [DEAD_ID], "dead members are pruned");
  assert.deepEqual(fake.events, [], "a live Session announces through session/disposed, not a manual event");
  await fs.rm(home, { recursive: true, force: true });
}

// 2. Cold Session: no store entries, manual announcement, file fallback.
{
  const home = await makeHome();
  const dir = await seed(home);
  const fake = fakeContext(home, { archived: [], pinned: [] });
  fake.liveSessions.clear();
  fake.liveAgents.clear();
  fake.ctx.get = () => undefined; // no Host services: the file fallback must cover it
  const report = await removeSession(fake.ctx, home, SESSION_ID);
  assert.equal(await exists(dir), false, "cold Session directory is removed");
  assert.equal(report.live, false, "report marks the Session cold");
  assert.equal(report.registryUpdated, true, "registry file fallback rewrote membership");
  assert.deepEqual(fake.events, [["api-session/removed", SESSION_ID]], "cold Session announces its removal");
  const registry = JSON.parse(await fs.readFile(path.join(home, "storages", "workspace.json"), "utf8"));
  assert.equal(registry.tables.workspaces["ws-1"].sessionIds.includes(SESSION_ID), false, "file fallback dropped the membership");
  assert.equal(registry.global.archivedSessionIds.includes(SESSION_ID), false, "file fallback dropped the archive entry");
  assert.equal(registry.global.pinnedSessionIds.includes(SESSION_ID), false, "file fallback dropped the pin");
  await fs.rm(home, { recursive: true, force: true });
}

console.log("delete-selftest: ok");
