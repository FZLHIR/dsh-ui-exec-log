/** Model test: fold a synthetic trajectory snapshot through buildTurns/traceSummary. */
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

let registered;
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => (registered = entry) } },
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: undefined,
  fetch: async () => ({ json: async () => ({}) }),
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync("D:/P/DSH/workspace/plugins/dsh-ui-exec-log/client.js", "utf8"), sandbox, {
  filename: "client.js",
});
const exports = registered.factory((name) => (name === "react" ? react : {}));

const snapshot = {
  eventNodes: [
    { kind: "user", seq: 1, turn: 0, blocks: [{ kind: "text", text: "把执行轨迹塞进右栏" }] },
    {
      kind: "assistant",
      seq: 2,
      turn: 0,
      step: 1,
      blocks: [
        { kind: "reasoning", text: "thinking" },
        { kind: "text", text: "摸清官方轨迹视图实现" },
        { kind: "tool-call", callId: "c1", name: "read", argsRaw: '{"path":"src/client.js"}' },
      ],
      timing: { stepStartTime: 1000, firstTokenTime: 1100, completedTime: 2000 },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
    { kind: "tool-result", seq: 3, callId: "c1", callTime: 1200, time: 1500, isError: false },
  ],
  requests: [
    { turn: 0, step: 1, purpose: "assistant", status: "complete", startedAt: 1000, completedAt: 2000, usage: { inputTokens: 10, outputTokens: 20 } },
  ],
  runningCalls: [],
};

const turns = exports.__internals.buildTurns(snapshot);
assert.equal(turns.length, 1);
assert.equal(turns[0].user.text, "把执行轨迹塞进右栏");
assert.equal(turns[0].steps.length, 1);
const step = turns[0].steps[0];
assert.equal(step.title, "摸清官方轨迹视图实现");
assert.equal(step.seq, 2);
assert.equal(step.actions.length, 1);
assert.equal(step.actions[0].name, "read");
assert.equal(step.actions[0].status, "ok");
assert.equal(exports.__internals.traceSummary(step), "已读取文件");

// Render smoke: calling the components directly executes their render paths,
// which is where a missing identifier (a color token, for example) would throw.
const panel = exports.__internals.TracePanel({
  t: (key) => key,
  sessionId: "session-test",
  useTrajectory: (select) => select(snapshot),
});
void panel;
const settings = exports.__internals.ToolkitSection({ t: (key) => key });
void settings;
const switches = exports.__internals.FeatureSwitches({ t: (key) => key, view: "page" });
void switches;


// Detail smoke: every selection kind must render without throwing.
const detailGroups = [
  { kind: "step", index: 0, turn: 0, step },
  { kind: "user", index: 0, turn: 0, step: { title: "用户消息", summary: "hi", status: "ok", startedAt: null, completedAt: null, input: null, output: null, actions: [], preview: "", reasoning: "" } },
];
for (const selection of [null, { kind: "turn", turn: 0 }, { kind: "step", index: 0 }, { kind: "user", index: 0 }, { kind: "row", index: 0, row: "assistant" }, { kind: "row", index: 0, row: "c1" }]) {
  exports.__internals.TraceDetail({ t: (key) => key, selection, groups: detailGroups });
}

console.log("model-selftest: ok");
