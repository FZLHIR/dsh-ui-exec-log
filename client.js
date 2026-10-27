/**
 * Browser half of `@local/dsh-ui-exec-log`.
 *
 * Registers one right-Sidebar tab type ("exec-log") through the public two-stage
 * path: the type declaration in `sidebarRightTabs`, then the body and title seats
 * in `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`, both keyed by the
 * definition id. The guide entry rides the type registration, so the Sidebar's own
 * guide renders the opening capsule (a custom card is unnecessary).
 *
 * Data (v0.2): the body reads the session's trajectory snapshot through the
 * framework-injected `useTrajectory` standard prop - no remote call of our own.
 * Turn rows aggregate assistant-node `usage` (inputTokens / outputTokens) and the
 * step timings; action rows pair each assistant `tool-call` block with its
 * `tool-result` node, so a call's duration is `result.time - result.callTime`
 * (both epoch-ms) and its status comes from `result.isError`. In-flight calls come
 * from `snapshot.runningCalls`.
 *
 * Features: one plugin ships three independently switchable features - the
 * execution log above, the plain-language plugin view, and Session deletion.
 * `featureFlags` owns the switches (persisted in `localStorage`), `gateFeature`
 * mounts one feature's seats and withdraws exactly those when its switch goes
 * off, and the Settings page (`ToolkitSection`) renders the list. The Host half
 * keeps the delete routes; the switches are client-side only.
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-ui-exec-log",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const useMemo = react.useMemo;
    const useState = react.useState;
    const useEffect = react.useEffect;
    const useRef = react.useRef;

    /** No rows are expanded when the panel mounts. */
    const EMPTY_SET = new Set();

    /** Toggle one key inside an immutable Set, for the expandable rows. */
    function toggleIn(set, key) {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    }

    /* ================================================================== *
     * Trace panel v2: one-column step ledger with mind-map connectors.
     *
     * The panel owns the right-hand list. The conversation is official UI; we
     * never inject into it. Instead the overlay layer measures the shipped
     * `[data-chat-flow-kind]` rows and our own `[data-fzl-*]` rows, pairs them in
     * order, and draws the connectors. When the shipped attributes disappear the
     * layer draws nothing and the panel marks the indicator unavailable, which is
     * the tolerated failure mode for upstream changes.
     * ================================================================== */

    const TRACE_ROW = "data-fzl-row";
    const TRACE_STEP = "data-fzl-step-index";
    const TRACE_USER = "data-fzl-user-index";

    /** First non-empty line of a text block, clamped for a row title. */
    function traceFirstLine(text, limit = 34) {
      if (typeof text !== "string") return "";
      const line = text
        .split(/\r?\n/)
        .map((part) => part.trim())
        .find((part) => part !== "");
      if (line === undefined) return "";
      return line.length > limit ? line.slice(0, limit - 1) + "..." : line;
    }

    /**
     * Merge raw LLM steps into the steps a reader sees.
     *
     * One log step is one model call, so a tool loop produces several steps
     * without prose. The official process list shows only the steps that carry
     * text; the tool-only ones belong to the visible step before them. Merging
     * keeps the panel's step count equal to the conversation's.
     */
    /** Official process-group boundaries per turn: the first step of each group. */
    const traceGroupBounds = new Map();

    /** Merge display steps so each turn has exactly the conversation's groups. */
    /**
     * Split a turn into the conversation's process groups.
     *
     * The chat flushes the pending reasoning/tool run and starts a new group at
     * every assistant reply, so the group count of a turn equals its replies plus
     * one. Merging our display steps on the same boundaries keeps the sidebar's
     * step count equal to the conversation's.
     */
    function groupStepsByReply(turns) {
      return turns.map((turn) => {
        const groups = [];
        let bucket = [];
        const close = () => {
          if (bucket.length > 0) groups.push(bucket);
          bucket = [];
        };
        for (const step of turn.steps) {
          bucket.push(step);
          if (step.title !== "" || step.preview !== "") close();
        }
        close();
        const steps = groups.map((members) => {
          const first = members[0];
          const merged = {
            ...first,
            actions: members.flatMap((member) => member.actions),
            sequence: members.flatMap((member) => member.sequence ?? []),
            rawSteps: members.flatMap((member) => (Array.isArray(member.rawSteps) ? member.rawSteps : [member.step])),
            reasoning: members.map((member) => member.reasoning).filter((value) => value !== "").join("\n\n"),
            startedAt: members.reduce((value, member) => (member.startedAt === null ? value : value === null ? member.startedAt : Math.min(value, member.startedAt)), null),
            completedAt: members.reduce((value, member) => (member.completedAt === null ? value : value === null ? member.completedAt : Math.max(value, member.completedAt)), null),
            input: members.reduce((sum, member) => sum + (member.input === null ? 0 : member.input), 0),
            output: members.reduce((sum, member) => sum + (member.output === null ? 0 : member.output), 0),
          };
          if (members.some((member) => member.status === "error")) merged.status = "error";
          return merged;
        });
        return { ...turn, steps: steps.map((step, index) => ({ ...step, displayStep: index + 1 })) };
      });
    }

    function groupStepsByBounds(turns, bounds) {
      if (bounds === undefined || bounds.size === 0) return turns;
      return turns.map((turn) => {
        const starts = bounds.get(turn.turn);
        if (!Array.isArray(starts) || starts.length === 0) return turn;
        const buckets = [];
        for (const step of turn.steps) {
          const raw = Array.isArray(step.rawSteps) && step.rawSteps.length > 0 ? step.rawSteps : [step.step];
          const first = Math.min(...raw);
          let index = 0;
          for (let cursor = 0; cursor < starts.length; cursor += 1) if (first >= starts[cursor]) index = cursor;
          if (buckets[index] === undefined) {
            buckets[index] = { ...step, actions: [...step.actions], sequence: [...step.sequence], rawSteps: [...raw] };
            continue;
          }
          const previous = buckets[index];
          previous.actions = previous.actions.concat(step.actions);
          previous.sequence = previous.sequence.concat(step.sequence);
          previous.rawSteps = previous.rawSteps.concat(raw);
          previous.reasoning =
            step.reasoning === ""
              ? previous.reasoning
              : previous.reasoning === ""
                ? step.reasoning
                : previous.reasoning + "\n\n" + step.reasoning;
          previous.startedAt = previous.startedAt === null ? step.startedAt : previous.startedAt;
          previous.completedAt = step.completedAt === null ? previous.completedAt : step.completedAt;
          previous.input = (previous.input === null ? 0 : previous.input) + (step.input === null ? 0 : step.input);
          previous.output = (previous.output === null ? 0 : previous.output) + (step.output === null ? 0 : step.output);
          if (step.status === "error") previous.status = "error";
        }
        return { ...turn, steps: buckets.filter((step) => step !== undefined).map((step, index) => ({ ...step, displayStep: index + 1 })) };
      });
    }

    function mergeTraceSteps(turns) {
      return turns.map((turn) => {
        const merged = [];
        for (const step of turn.steps) {
          const hasText = (step.title !== undefined && step.title !== "") || step.preview !== "";
          if (!hasText && merged.length > 0) {
            const previous = merged[merged.length - 1];
            previous.actions = previous.actions.concat(step.actions);
            previous.rawSteps = (previous.rawSteps ?? []).concat(step.step);
            previous.sequence = previous.sequence.concat(step.sequence);
            previous.reasoning =
              step.reasoning === ""
                ? previous.reasoning
                : previous.reasoning === ""
                  ? step.reasoning
                  : previous.reasoning + "\n\n" + step.reasoning;
            previous.startedAt = previous.startedAt === null ? step.startedAt : previous.startedAt;
            previous.completedAt = step.completedAt === null ? previous.completedAt : step.completedAt;
            previous.input = (previous.input === null ? 0 : previous.input) + (step.input === null ? 0 : step.input);
            previous.output = (previous.output === null ? 0 : previous.output) + (step.output === null ? 0 : step.output);
            if (step.status === "error") previous.status = "error";
            continue;
          }
          merged.push({ ...step, actions: [...step.actions], rawSteps: [step.step] });
        }
        const visible = merged.map((step, index) => ({ ...step, displayStep: index + 1 }));
        const last = visible[visible.length - 1];
        if (last !== undefined) {
          const cut = last.sequence.map((entry) => entry.kind).lastIndexOf("text");
          if (cut >= 0) last.sequence = last.sequence.filter((entry, position) => position !== cut);
        }
        return { ...turn, steps: visible };
      });
    }

    /**
     * The official activity categories, keyed the way the chat's step dictionary
     * names them. The panel composes the same sentences the conversation shows.
     */
    const TRACE_DONE = {
      read: "已读取文件",
      write: "已写入文件",
      search: "已搜索代码",
      edit: "修改了文件",
      commands: "执行了命令",
      code: "运行了代码",
      webSearch: "已搜索网页",
      webFetch: "已访问网页",
      subagents: "已协调子智能体",
      plan: "更新了计划",
      questions: "向用户提出了问题",
      tools: "已调用工具",
    };
    const TRACE_LIVE = {
      read: "正在读取文件",
      write: "正在写入文件",
      search: "正在搜索代码",
      edit: "正在编辑文件",
      commands: "正在运行命令",
      code: "正在运行代码",
      webSearch: "正在搜索网页",
      webFetch: "正在访问网页",
      subagents: "正在协调子智能体",
      plan: "正在更新计划",
      questions: "等待你的操作",
      tools: "正在调用工具",
    };
    const TRACE_TOOL_LABEL = {
      read: "读取文件",
      write: "写文件",
      search: "搜索代码",
      edit: "编辑文件",
      commands: "运行命令",
      code: "运行代码",
      webSearch: "搜索网页",
      webFetch: "访问网页",
      subagents: "子智能体",
      plan: "更新计划",
      questions: "提问",
      tools: "工具调用",
    };
    const TRACE_PREPARE = {
      read: "准备读取文件",
      write: "准备写入文件",
      search: "准备搜索代码",
      edit: "准备编辑文件",
      commands: "准备运行命令",
      code: "准备运行代码",
      webSearch: "准备搜索网页",
      webFetch: "准备访问网页",
      subagents: "准备协调子智能体",
      plan: "准备更新计划",
      questions: "准备提问",
      tools: "准备调用工具",
    };

    /** Leading English verbs the model uses in tool descriptions. */
    const TRACE_VERB_ZH = {
      read: "读取", check: "检查", fix: "修复", run: "运行", verify: "验证", update: "更新",
      add: "添加", record: "记录", render: "渲染", patch: "修改", explain: "说明", reorder: "重排",
      move: "移动", remove: "删除", create: "创建", write: "写入", build: "构建", test: "测试",
      install: "安装", clean: "清理", inspect: "查看", start: "开始", stop: "停止", replace: "替换",
      simplify: "简化", translate: "翻译", merge: "合并", find: "查找", list: "列出", show: "显示",
      open: "打开", close: "关闭", kill: "终止", restart: "重启", reload: "重载", debug: "调试",
      trace: "追踪", load: "加载", save: "保存", parse: "解析", format: "格式化", sort: "排序",
      filter: "过滤", group: "分组", split: "拆分", join: "拼接", copy: "复制", dump: "导出",
      scan: "扫描", get: "获取", set: "设置", use: "使用", call: "调用", send: "发送", fetch: "抓取",
      apply:"应用", adjust:"调整", align:"对齐", decouple:"解耦", restructure:"重构", rewrite:"重写",
    };

    /** Recurring English phrases in tool descriptions, longest first. */
    const TRACE_PHRASES = [
      ["assistant block", "助手块"], ["reasoning label", "推理标签"], ["step rows", "步骤行"],
      ["turn process", "轮过程"], ["final reply", "最终回复"], ["tool description", "工具说明"],
      ["row order", "行顺序"], ["step header", "步头"], ["turn header", "轮头"], ["the panel", "面板"],
      ["the sidebar", "侧栏"], ["the conversation", "对话"], ["official", "官方"], ["reasoning", "推理"],
      ["streaming", "流式"], ["collapse", "折叠"], ["expand", "展开"], ["sequence", "序列"],
      ["tests pass", "测试通过"], ["test expectation", "测试预期"], ["mock", "模拟"],
      ["headers", "标题"], ["header", "标题"], ["rows", "行"], ["row", "行"], ["block", "块"],
      ["loop", "循环"], ["structure", "结构"], ["details", "详情"], ["detail", "详情"],
      ["order", "顺序"], ["list", "列表"], ["panel", "面板"], ["sidebar", "侧栏"],
      ["conversation", "对话"], ["step", "步骤"], ["turn", "轮"], ["label", "标签"],
      ["render", "渲染"], ["patch", "补丁"], ["fix", "修复"], ["check", "检查"], ["verify", "验证"],
      ["update", "更新"], ["remove", "移除"], ["add", "添加"], ["record", "记录"], ["replace", "替换"],
      ["explain", "说明"], ["compare", "对比"], ["build", "构建"], ["write", "写入"], ["read", "读取"],
    ];

    /** Translate the phrases the dictionary knows; unknown English stays as-is. */
    function traceTranslate(text) {
      let value = text;
      for (const [english, chinese] of TRACE_PHRASES) {
        const pattern = new RegExp("\\b" + english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
        value = value.replace(pattern, chinese);
      }
      return value;
    }

    /** The sentence a tool row shows after its action label. */
    function traceTarget(action) {
      if (action === undefined) return "";
      let value = "";
      try {
        const args = JSON.parse(action.argsRaw);
        if (args !== null && typeof args === "object") {
          for (const key of ["description", "intent", "title", "purpose", "reason", "summary"]) {
            if (typeof args[key] === "string" && args[key].trim() !== "") { value = args[key].trim(); break; }
          }
          if (value === "") {
            for (const key of ["file_path", "path", "pattern", "url", "command", "query"]) {
              if (typeof args[key] === "string" && args[key].trim() !== "") { value = args[key].trim(); break; }
              if (Array.isArray(args[key]) && typeof args[key][0] === "string") { value = args[key][0]; break; }
            }
          }
        }
      } catch (error) {
        value = "";
      }
      if (value === "") value = action.target;
      value = value.replace(/\s+/g, " ").trim();
      const match = /^([A-Za-z]+)(\b[\s\S]*)$/.exec(value);
      if (match !== null) {
        const translated = TRACE_VERB_ZH[match[1].toLowerCase()];
        if (translated !== undefined) value = translated + match[2];
      }
      value = traceTranslate(value);
      return value.length > 90 ? value.slice(0, 89) + "..." : value;
    }

    /** Map one tool name onto an official activity category. */
    function traceCategory(name) {
      if (typeof name !== "string" || name === "") return "tools";
      if (/^(read|read_image|view|cat)$/.test(name)) return "read";
      if (/^(glob|grep|search|list|ls|find)$/.test(name)) return "search";
      if (/^(edit|apply_patch|notebook_edit)$/.test(name)) return "edit";
      if (/^(write|create|write_file)$/.test(name)) return "write";
      if (/^(bash|pwsh|shell|terminal)/.test(name)) return "commands";
      if (/^(run_code|ptc|execute_code)$/.test(name)) return "code";
      if (/^web_search$/.test(name)) return "webSearch";
      if (/^(web_fetch|fetch)$/.test(name)) return "webFetch";
      if (/^(subagent|task|spawn_teammate|workflow)$/.test(name)) return "subagents";
      if (/^todo_write$/.test(name)) return "plan";
      if (/^ask_user_question$/.test(name)) return "questions";
      return "tools";
    }

    /** Activity categories of one step, most frequent first. */
    function traceCategories(step) {
      const counts = new Map();
      for (const action of step.actions) {
        const category = traceCategory(action.name);
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([category]) => category);
    }

    /** One activity sentence, joined the way the chat joins it. */
    function traceJoin(labels) {
      if (labels.length === 0) return "";
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) {
        const second = labels[1].startsWith("已") ? labels[1].slice(1) : labels[1];
        return labels[0] + "并" + second;
      }
      const title = labels.slice(0, 3).join("，");
      return labels.length > 3 ? title + "等" : title;
    }

    /** The single activity sentence a step header carries. */
    function traceSummary(step) {
      const categories = traceCategories(step);
      if (step.status === "running") {
        const activity = categories[0] ?? "thinking";
        return activity === "thinking" ? "正在分析请求" : TRACE_LIVE[activity] ?? TRACE_LIVE.tools;
      }
      if (categories.length === 0) return step.reasoning !== "" ? "已完成分析" : "";
      return traceJoin(categories.map((category) => TRACE_DONE[category] ?? TRACE_DONE.tools));
    }

    /** Wall time of one turn, as a compact label. */
    function turnDuration(turn) {
      const spans = turn.steps
        .filter((step) => step.startedAt !== null && step.completedAt !== null)
        .map((step) => Math.max(0, step.completedAt - step.startedAt));
      if (spans.length === 0) return "";
      return formatMs(spans.reduce((sum, value) => sum + value, 0));
    }

    /** Whether the panel takes over the official step disclosure. */
    const traceIntercept = (() => {
      const KEY = "dsh-exec-log.intercept";
      let value = true;
      try {
        const saved = localStorage.getItem(KEY);
        if (saved === "0" || saved === "1") value = saved === "1";
      } catch (error) {
        // Storage may be unavailable; the default stays.
      }
      const listeners = new Set();
      return {
        get: () => value,
        set: (next) => {
          value = next;
          try {
            localStorage.setItem(KEY, next ? "1" : "0");
          } catch (error) {
            // A failed write only costs persistence.
          }
          for (const listener of [...listeners]) listener(next);
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** Client ctx, captured for the cot-translation Remote. */
    let execLogCtx = null;

    /**
     * Compatibility with the CoT-translation plugin: translate reasoning through
     * its own Remote (the reader's provider), cache per text, never block.
     */
    const traceTranslation = (() => {
      const ENABLED = "dsh-exec-log.cot";
      const CACHE = "dsh-exec-log.cot.cache";
      let enabled = false;
      try {
        enabled = localStorage.getItem(ENABLED) === "1";
      } catch (error) {
        enabled = false;
      }
      const cache = new Map();
      try {
        const raw = localStorage.getItem(CACHE);
        if (raw !== null) for (const [key, value] of JSON.parse(raw)) cache.set(key, value);
      } catch (error) {
        // A broken cache only costs re-translation.
      }
      const pending = new Set();
      const listeners = new Set();
      let lastStatus = "idle";
      const setStatus = (next) => {
        if (lastStatus === next) return;
        lastStatus = next;
        for (const listener of [...listeners]) listener();
      };
      const notify = () => {
        for (const listener of [...listeners]) listener();
      };
      const save = () => {
        try {
          localStorage.setItem(CACHE, JSON.stringify([...cache].slice(-300)));
        } catch (error) {
          // Persistence is best effort.
        }
      };
      return {
        enabled: () => enabled,
        setEnabled: (next) => {
          enabled = next;
          try {
            localStorage.setItem(ENABLED, next ? "1" : "0");
          } catch (error) {
            // Persistence is best effort.
          }
          notify();
        },
        get: (text) => cache.get(text),
        status: () => lastStatus,
        request: (text, sessionId) => {
          if (!enabled || cache.has(text) || pending.has(text)) return;
          pending.add(text);
          setStatus("pending");
          const controller = typeof AbortController === "function" ? new AbortController() : undefined;
          const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 10000);
          fetch("/fzl-toolkit/translate", {
            method: "POST",
            headers: { "content-type": "application/json", "x-fzl-toolkit": "1" },
            body: JSON.stringify({ text, ...(sessionId === undefined || sessionId === null ? {} : { sessionId }) }),
            ...(controller === undefined ? {} : { signal: controller.signal }),
          })
            .then((response) => response.json())
            .then((payload) => {
              if (payload !== null && payload !== undefined && payload.ok === true && typeof payload.text === "string" && payload.text !== "") {
                cache.set(text, payload.text);
                save();
                notify();
                setStatus("ok");
              } else {
                setStatus(payload !== null && payload !== undefined && typeof payload.error === "string" ? payload.error : "fail");
              }
            })
            .catch(() => {
              setStatus("fail");
            })
            .finally(() => {
              if (timer !== undefined) clearTimeout(timer);
              pending.delete(text);
            });
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** Whether the connector layer draws. */
    const traceLines = (() => {
      const KEY = "dsh-exec-log.lines";
      let value = true;
      try {
        const saved = localStorage.getItem(KEY);
        if (saved === "0" || saved === "1") value = saved === "1";
      } catch (error) {
        // The default stays when storage is unavailable.
      }
      const listeners = new Set();
      return {
        get: () => value,
        set: (next) => {
          value = next;
          try {
            localStorage.setItem(KEY, next ? "1" : "0");
          } catch (error) {
            // Persistence is best effort.
          }
          for (const listener of [...listeners]) listener(next);
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** Display step identity: index, turn, and the raw step numbers it merged. */
    let traceStepModel = [];

    /** Survives a tab remount so the fold state is not reset by new activity. */
    const traceCollapsed = { value: null };

    /**
     * The list step a positional focus request names.
     *
     * Both directions pair the k-th conversation group of a turn with the k-th
     * list step of the same turn. A request whose index sits past the last step
     * (a merged tail, or a timing race) resolves to the last step rather than to
     * the first one, which is always wrong and easy to notice.
     */
    function pickFocusStep(own, position) {
      if (!Array.isArray(own) || own.length === 0) return undefined;
      if (typeof position !== "number" || !Number.isFinite(position)) return own[0];
      const index = Math.min(Math.max(Math.trunc(position), 0), own.length - 1);
      return own[index];
    }

    /** One-shot focus request: the conversation names a step, the list decides. */
    const traceFocus = (() => {
      let value = null;
      const listeners = new Set();
      return {
        get: () => value,
        set: (next) => {
          value = next;
          for (const listener of [...listeners]) listener(next);
        },
        clear: () => {
          value = null;
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** Module-level hand-off between the chat's click listener and the panel. */
    const traceBridge = (() => {
      let current = null;
      const listeners = new Set();
      return {
        get: () => current,
        set: (next) => {
          current = next;
          for (const listener of [...listeners]) listener(next);
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** True when a measured element is actually on screen. */
    function traceVisible(element) {
      if (element === null || element === undefined) return false;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || 0);
    }

    /** One smooth connector between two points, mind-map style. */
    function traceCurve(x1, y1, x2, y2) {
      const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }

    /** Open or fold one turn's official process disclosure, when it is on screen. */
    function traceSetChatTurnCollapsed(turn, collapse) {
      try {
        const row = document.querySelector('[data-chat-flow-kind="turn-process"][data-chat-turn="' + turn + '"]');
        const button = row === null ? null : row.querySelector("button");
        if (button === null) return;
        const state = button.getAttribute("aria-expanded");
        if (collapse && state === "true") button.click();
        if (!collapse && state === "false") button.click();
      } catch (error) {
        // Upstream markup changes must not make collapsing fail.
      }
    }

    /** Paint one connector per visible conversation step to its list row. */
    function paintTraceCurves() {
      if (typeof document === "undefined") return;
      const svg = document.querySelector("[data-fzl-curves]");
      if (svg === null) return;
      const clear = () => {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
      };
      if (!traceLines.get()) {
        clear();
        return;
      }
      const panel = document.querySelector("[data-fzl-panel]");
      if (panel === null || !traceVisible(panel)) {
        clear();
        return;
      }
      const chatRegion = document.querySelector("[data-conversation-region=\"chat\"]") ?? document.querySelector("[data-conversation-scroll]");
      const listRegion = document.querySelector("[data-fzl-list]");
      const inside = (element, region) => {
        if (!traceVisible(element)) return false;
        if (region === null || region === undefined) return true;
        const bounds = region.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      };
      const panelGroups = [...document.querySelectorAll("[data-fzl-step-index]")];
      if (panelGroups.length === 0) {
        clear();
        return;
      }
      const chatGroups = [...document.querySelectorAll("[data-step-process]")].filter((group) => inside(group, chatRegion));
      const fragment = document.createDocumentFragment();
      const add = (path, color, width) => {
        const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
        element.setAttribute("d", path);
        element.setAttribute("fill", "none");
        element.setAttribute("stroke", color);
        element.setAttribute("stroke-width", String(width));
        fragment.appendChild(element);
      };
      const selected = traceBridge.get();

      const used = new Set();
      for (const chat of chatGroups) {
        const turn = Number(chat.getAttribute("data-chat-turn"));
        if (!Number.isFinite(turn)) continue;
        // Position among every group of the turn, not only the visible ones:
        // scrolling must never shift which list row a step points at.
        const siblings = [...document.querySelectorAll("[data-step-process]")].filter(
          (candidate) => Number(candidate.getAttribute("data-chat-turn")) === turn,
        );
        const position = siblings.indexOf(chat);
        const own = panelGroups
          .filter((candidate) => Number(candidate.getAttribute("data-fzl-turn")) === turn)
          .sort((left, right) => Number(left.getAttribute("data-fzl-step-index")) - Number(right.getAttribute("data-fzl-step-index")));
        const target = own[position];
        if (target === undefined) continue;
        const targetIndex = Number(target.getAttribute("data-fzl-step-index"));
        if (used.has(targetIndex)) continue;
        used.add(targetIndex);
        const button = chat.querySelector("button");
        const header = (button === null ? chat : button).getBoundingClientRect();
        const ownRect = target.getBoundingClientRect();
        if (ownRect.width === 0 || header.width === 0) continue;
        const active =
          selected !== null &&
          selected.kind === "step" &&
          Number(target.getAttribute("data-fzl-step-index")) === Number(selected.index);
        const visible = inside(target, listRegion);
        const listBounds = listRegion === null || listRegion === undefined ? null : listRegion.getBoundingClientRect();
        const above = listBounds !== null && ownRect.bottom < listBounds.top;
        const below = listBounds !== null && ownRect.top > listBounds.bottom;
        const endX = visible ? ownRect.left - 4 : listBounds === null ? ownRect.left - 4 : listBounds.left + 6;
        const endY = visible
          ? ownRect.top + ownRect.height / 2
          : listBounds === null
            ? 0
            : above
              ? listBounds.top + 8
              : below
                ? listBounds.bottom - 8
                : ownRect.top + ownRect.height / 2;
        add(
          traceCurve(header.right - 6, header.top + header.height / 2, endX, endY),
          active ? "#3b6fd4" : "#9fc0ee",
          active ? 1.9 : 1.2,
        );
      }

      clear();
      svg.appendChild(fragment);
    }

    /** The overlay that hosts every connector. */
    function TraceCurves() {
      const ref = useRef(null);
      useEffect(() => {
        let running = true;
        let frame = 0;
        let last = 0;
        const tick = (time) => {
          if (!running) return;
          if (time - last > 90) {
            last = time;
            try {
              paintTraceCurves();
            } catch (error) {
              // One malformed upstream row must never break the page.
            }
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
          running = false;
          cancelAnimationFrame(frame);
        };
      }, []);
      return h("svg", {
        ref: ref,
        "data-fzl-curves": "1",
        "aria-hidden": "true",
        style: { position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 60 },
      });
    }

    /** One transient marker on a conversation row, cleared on the next jump. */
    let traceFlashed = null;
    function traceFlash(element) {
      if (element === null || element === undefined) return;
      if (traceFlashed !== null && traceFlashed !== element) {
        traceFlashed.style.boxShadow = "";
        traceFlashed.style.borderRadius = "";
        traceFlashed.style.transition = "";
      }
      traceFlashed = element;
      element.style.transition = "box-shadow 160ms ease";
      element.style.boxShadow = "inset 0 0 0 2px #3b6fd4";
      element.style.borderRadius = "8px";
      setTimeout(() => {
        if (traceFlashed === element) {
          element.style.boxShadow = "";
          element.style.borderRadius = "";
          element.style.transition = "";
          traceFlashed = null;
        }
      }, 1600);
    }

    /** The raw step number a conversation process group belongs to. */
    function traceGroupStep(group) {
      try {
        const parsed = JSON.parse(group.getAttribute("data-chat-group-key") ?? "");
        const raw = Array.isArray(parsed) && typeof parsed[1] === "string" ? parsed[1] : "";
        const match = /^(\d+):/.exec(raw);
        return match === null ? undefined : Number(match[1]);
      } catch (error) {
        return undefined;
      }
    }

    /** Scroll the conversation to a step (or its turn row) — the reverse direction. */
    function traceRevealChatStep(turn, rawSteps) {
      if (typeof document === "undefined") return;
      const turns = Number.isFinite(turn) ? [turn, turn - 1, turn + 1] : [];
      const wanted = Array.isArray(rawSteps) && rawSteps.length > 0 ? rawSteps : [];
      const first = wanted.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...wanted);
      const attempt = (tries) => {
        for (const candidate of turns) traceSetChatTurnCollapsed(candidate, false);
        const groups = [...document.querySelectorAll("[data-step-process]")].filter((group) => {
          const turnOfGroup = Number(group.getAttribute("data-chat-turn"));
          return turns.includes(turnOfGroup) && traceVisible(group);
        });
        const parsed = groups.map((group) => {
          let stepNumber;
          try {
            const key = JSON.parse(group.getAttribute("data-chat-group-key") ?? "null");
            const raw = Array.isArray(key) && typeof key[1] === "string" ? key[1] : "";
            const match = /^(\d+):/.exec(raw);
            if (match !== null) stepNumber = Number(match[1]);
          } catch (error) {
            stepNumber = undefined;
          }
          return { group, stepNumber };
        });
        const exact = parsed.find((entry) => entry.stepNumber !== undefined && wanted.includes(entry.stepNumber));
        const nearest = exact === undefined
          ? parsed.filter((entry) => entry.stepNumber !== undefined && entry.stepNumber <= first).pop()
          : undefined;
        const target = exact === undefined ? (nearest === undefined ? undefined : nearest.group) : exact.group;
        if (target !== undefined) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          traceFlash(target);
          return;
        }
        if (tries < 20) setTimeout(() => attempt(tries + 1), 70);
      };
      setTimeout(() => attempt(0), 80);
    }

    function TraceDetail(props) {
      const t = props.t;
      const selection = props.selection;
      const groups = props.groups;
      const hint = () => h("div", { style: { fontSize: 11.5, color: MUTED } }, t("traceSelect"));
      const facts = (entries) =>
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginTop: 12 } },
          entries.map(([key, value]) =>
            h("div", { key: key }, h("div", { style: { fontSize: 10, color: MUTED } }, key), h("div", { style: { fontSize: 12, color: PRIMARY } }, value)),
          ),
        );
      const mono = (text) =>
        h(
          "pre",
          { style: { margin: "4px 0 0", padding: "7px 9px", background: MONO_BG, border: "1px solid " + BORDER, borderRadius: 6, fontSize: 10, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", color: SECONDARY, maxHeight: 180, overflow: "auto" } },
          text,
        );
      const status = (value) => (value === "error" ? t("failed") : value === "running" ? t("running") : t("done"));

      if (selection === null) return hint();

      if (selection.kind === "turn") {
        const steps = groups.filter((entry) => entry.kind === "step" && entry.turn === selection.turn);
        if (steps.length === 0) return hint();
        const tools = steps.reduce((sum, entry) => sum + entry.step.actions.length, 0);
        const input = steps.reduce((sum, entry) => sum + (entry.step.input === null ? 0 : entry.step.input), 0);
        const output = steps.reduce((sum, entry) => sum + (entry.step.output === null ? 0 : entry.step.output), 0);
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: PRIMARY } }, t("traceTurn", { turn: selection.turn })),
          h("div", { style: { marginTop: 3, fontSize: 11, color: SECONDARY } }, steps.length + " " + t("traceStepUnit") + " · " + tools + " " + t("traceCalls")),
          facts([
            [t("traceStatus"), steps.some((entry) => entry.step.status === "error") ? t("failed") : steps.some((entry) => entry.step.status === "running") ? t("running") : t("done")],
            [t("traceDuration"), turnDuration({ steps: steps.map((entry) => entry.step) })],
            [t("traceTokens"), formatCount(input + output)],
            [t("traceCalls"), String(tools)],
          ]),
        );
      }

      const wanted = selection.kind === "user" ? "user" : "step";
      const group = groups.find((entry) => entry.kind === wanted && entry.index === selection.index);
      if (group === undefined) return hint();
      const step = group.step;

      if (selection.kind === "user") {
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: PRIMARY } }, t("traceMessage")),
          h("div", { style: { marginTop: 6, fontSize: 11.5, color: SECONDARY, lineHeight: 1.7, whiteSpace: "pre-wrap" } }, step.summary === "" ? step.title : step.summary),
        );
      }

      if (selection.kind === "row" && selection.row === "reasoning") {
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: PRIMARY } }, t("kindThinking")),
          h("div", { style: { marginTop: 3, fontSize: 10.5, color: MUTED } }, t("traceStep", { step: step.displayStep === undefined ? step.step : step.displayStep })),
          h("div", { style: { marginTop: 10, fontSize: 11.5, color: SECONDARY, lineHeight: 1.75, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, selection.position !== undefined && Array.isArray(step.sequence) && step.sequence[selection.position] !== undefined ? step.sequence[selection.position].text : step.reasoning),
        );
      }

      if (selection.kind === "row" && selection.row !== undefined && selection.row !== "assistant") {
        const action = step.actions.find((entry) => entry.callId === selection.row);
        if (action === undefined) return hint();
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: PRIMARY } }, action.name),
          h("div", { style: { marginTop: 3, fontSize: 11, color: SECONDARY } }, action.target === "" ? t("traceStep", { step: step.displayStep === undefined ? step.step : step.displayStep }) : action.target),
          facts([
            [t("traceStatus"), status(action.status)],
            [t("traceDuration"), formatMs(action.ms)],
            [t("kindTool"), action.name],
            [t("traceStep"), step.title === "" ? String(step.displayStep === undefined ? step.step : step.displayStep) : step.title],
          ]),
          h("div", { style: { marginTop: 12, fontSize: 10, color: MUTED } }, t("traceArgs")),
          mono(prettyJson(action.argsRaw)),
          action.output === ""
            ? null
            : h("div", { key: "out" },
                h("div", { style: { marginTop: 12, fontSize: 10, color: MUTED } }, t("traceResult")),
                mono(action.output.slice(0, 3000))),
        );
      }

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, color: PRIMARY } }, t("traceStep", { step: step.displayStep === undefined ? step.step : step.displayStep }) + (traceSummary(step) === "" ? "" : " · " + traceSummary(step))),
        h("div", { style: { marginTop: 3, fontSize: 11, color: SECONDARY } }, step.title),
        facts([
          [t("traceStatus"), status(step.status)],
          [t("traceDuration"), formatMs(step.startedAt !== null && step.completedAt !== null ? Math.max(0, step.completedAt - step.startedAt) : null)],
          [t("traceTokens"), formatCount((step.input === null ? 0 : step.input) + (step.output === null ? 0 : step.output))],
          [t("traceCalls"), String(step.actions.length)],
        ]),
        step.preview === ""
          ? null
          : h("div", { key: "preview", style: { marginTop: 12, fontSize: 11.5, color: SECONDARY, lineHeight: 1.7, whiteSpace: "pre-wrap" } }, step.preview),
      );
    }

    /**
     * The trace panel body.
     *
     * One column in the normal Sidebar; the same component splits into list and
     * detail once the Sidebar's fullscreen mode gives it enough width. Rows carry
     * the stable `data-fzl-*` attributes the curve layer measures.
     */
    function TracePanel(props) {
      const t = (key, vars) => (props && typeof props.t === "function" ? props.t(key, vars) : key);
      const useTrajectory = props ? props.useTrajectory : undefined;
      const useSession = props ? props.useSession : undefined;
      const sessionRunning = typeof useSession === "function" ? useSession((state) => state.running === true) : false;
      const snapshot = typeof useTrajectory === "function" ? useTrajectory((value) => value) : undefined;
      const [boundsVersion, setBoundsVersion] = useState(0);
      const [turns, modelError] = useMemo(() => {
        try {
          return [groupStepsByReply(mergeTraceSteps(buildTurns(snapshot === undefined ? undefined : snapshot))), ""];
        } catch (error) {
          return [[], String(error && error.message ? error.message : error)];
        }
      }, [snapshot]);
      const [selection, setSelection] = useState(() => traceBridge.get());
      const [width, setWidth] = useState(0);
      const [collapsedTurns, setCollapsedState] = useState(() => traceCollapsed.value ?? new Set());
      const setCollapsedTurns = (next) => {
        const value = new Set(typeof next === "function" ? next(traceCollapsed.value ?? collapsedTurns) : next);
        const newest = turns.length === 0 ? undefined : turns[turns.length - 1].turn;
        if (newest !== undefined) value.delete(newest);
        traceCollapsed.value = value;
        setCollapsedState(value);
      };
      const [openReasoning, setOpenReasoning] = useState(() => new Set());
      const [intercept, setIntercept] = useState(() => traceIntercept.get());
      const [lines, setLines] = useState(() => traceLines.get());
      const [cotVersion, setCotVersion] = useState(0);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const cotEnabled = traceTranslation.enabled();
      const sessionId = typeof useSession === "function" ? useSession((state) => state.sessionId ?? state.id) : undefined;
      const rootRef = useRef(null);
      const shipped = primitives();
      const ShippedSwitch = shipped !== null && typeof shipped.Switch === "function" ? shipped.Switch : undefined;
      const listRef = useRef(null);
      const stickToBottom = useRef(true);
      const openedAt = useRef(new Map());
      const wide = width >= 720;

      useEffect(() => traceBridge.subscribe(setSelection), []);
      useEffect(() => traceIntercept.subscribe(setIntercept), []);
      useEffect(() => traceLines.subscribe(setLines), []);
      useEffect(() => traceTranslation.subscribe(() => setCotVersion((value) => value + 1)), []);

      // First run with data: start in turn mode (everything folded).
      useEffect(() => {
        if (traceCollapsed.value !== null || turns.length === 0) return;
        setCollapsedTurns(new Set(turns.map((turn) => turn.turn)));
      }, [turns]);

      // A streaming reasoning block keeps its own scroll at the newest text.
      useEffect(() => {
        for (const element of document.querySelectorAll("[data-fzl-live]")) {
          element.scrollTop = element.scrollHeight;
        }
      }, [turns]);

      // While generating, follow the newest row unless the reader scrolled up.
      useEffect(() => {
        const element = listRef.current;
        if (element === null || !stickToBottom.current) return undefined;
        const timer = setTimeout(() => {
          element.scrollTop = element.scrollHeight;
        }, 40);
        return () => clearTimeout(timer);
      }, [turns]);

      // The conversation hands over a focus request; the list owns selection,
      // folding and scrolling. A request that arrives before the trajectory has
      // loaded is retried until the list can resolve it.
      useEffect(() => {
        let attempts = 0;
        let timer;
        const consume = (request) => {
          if (request === null || request === undefined) return false;
          let target;
          if (typeof request.callId === "string") {
            target = groups.find(
              (entry) => entry.kind === "step" && entry.step.actions.some((action) => action.callId === request.callId),
            );
          }
          // The conversation's turn number and this model's turn number can be
          // off by one, so both neighbours are accepted for the step lookup.
          const candidates = Number.isFinite(request.turn) ? [request.turn, request.turn - 1, request.turn + 1] : [];
          for (const turn of candidates) {
            if (target !== undefined) break;
            const own = groups.filter((entry) => entry.kind === "step" && entry.turn === turn);
            target = pickFocusStep(own, request.position);
          }
          if (target === undefined) return false;
          traceFocus.clear();
          setCollapsedTurns(() => new Set(turns.filter((turn) => turn.turn !== target.turn).map((turn) => turn.turn)));
          traceBridge.set({ kind: "step", index: target.index, source: "chat" });
          setSelection({ kind: "step", index: target.index, source: "chat" });
          let tries = 0;
          const scrollToTarget = () => {
            const row = document.querySelector("[" + TRACE_STEP + '="' + target.index + '"]');
            if (row !== null && typeof row.scrollIntoView === "function") {
              row.scrollIntoView({ block: "nearest" });
              return;
            }
            if (tries < 25) {
              tries += 1;
              setTimeout(scrollToTarget, 60);
            }
          };
          setTimeout(scrollToTarget, 60);
          return true;
        };
        const run = () => {
          if (consume(traceFocus.get())) return;
          if (attempts >= 15) return;
          attempts += 1;
          timer = setTimeout(run, 200);
        };
        const unsubscribe = traceFocus.subscribe(run);
        run();
        return () => {
          unsubscribe();
          clearTimeout(timer);
        };
      }, [turns]);


      useEffect(() => {
        const element = rootRef.current;
        if (element === null || typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      const groups = [];
      for (const turn of turns) {
        if (turn.user !== undefined) {
          groups.push({
            kind: "user",
            index: groups.filter((entry) => entry.kind === "user").length,
            turn: turn.turn,
            step: { title: "用户消息", summary: turn.user.text, status: "ok", startedAt: null, completedAt: null, input: null, output: null, actions: [], preview: "", reasoning: "" },
          });
        }
        for (const step of turn.steps) {
          groups.push({ kind: "step", index: groups.filter((entry) => entry.kind === "step").length, turn: turn.turn, step });
        }
      }

      traceStepModel = groups
        .filter((entry) => entry.kind === "step")
        .map((entry) => ({ index: entry.index, turn: entry.turn, rawSteps: entry.step.rawSteps ?? [entry.step.step] }));

      const select = (next) => {
        traceBridge.set(next === null ? null : { ...next, source: "panel" });
        // Reverse locating: a click in the list moves the conversation.
        try {
          if (next !== null && next.kind === "turn") {
            const row = document.querySelector('[data-chat-flow-kind="turn-process"][data-chat-turn="' + next.turn + '"]');
            if (row !== null && typeof row.scrollIntoView === "function") {
              row.scrollIntoView({ block: "center", behavior: "smooth" });
              traceFlash(row);
            }
          } else if (next !== null && next.kind === "step") {
            const group = groups.find((entry) => entry.kind === "step" && entry.index === next.index);
            if (group !== undefined) {
              traceRevealChatStep(group.turn, group.step.rawSteps ?? [group.step.step]);
            }
          }
        } catch (error) {
          // Reverse locating must never break selection.
        }
      };

      const rows = [];
      let stepCounter = 0;
      let userCounter = 0;
      for (const turn of turns) {
        const collapsed = collapsedTurns.has(turn.turn);
        rows.push(
          h("div", {
            key: "t" + turn.turn,
            "data-fzl-turn-head": String(turn.turn),
            onClick: () => select({ kind: "turn", turn: turn.turn }),
            style: selection !== null && selection.kind === "turn" && selection.turn === turn.turn ? TURN_HEAD_ACTIVE_STYLE : TURN_HEAD_STYLE,
          },
            h("span", {
              title: t("traceToggle"),
              onClick: (event) => {
                event.stopPropagation();
                const next = new Set(collapsedTurns);
                if (next.has(turn.turn)) next.delete(turn.turn);
                else next.add(turn.turn);
                setCollapsedTurns(next);
              },
              style: { paddingRight: 6, cursor: "pointer" },
            }, collapsed ? "\u25b8" : "\u25be"),
            h("span", null, t("traceTurn", { turn: turn.turn })),
            h("span", { style: { marginLeft: "auto", color: MUTED, fontWeight: 400 } },
              turnDuration(turn)),
          ),
        );
        if (collapsed) continue;

        if (turn.user !== undefined) {
          const userIndex = userCounter++;
          rows.push(
            h("div", { key: "u" + turn.turn, style: GROUP_STYLE },
              h("div", { "data-fzl-row": "u" + turn.turn, "data-fzl-user-index": String(userIndex), onClick: () => select({ kind: "user", index: userIndex }), style: ROW_STYLE },
                h("span", { style: LINENO_STYLE }, String(turn.user.seq)),
                h("span", { style: CHIP_STYLE("user") }, t("kindUser")),
                h("span", { style: rowSecondary() }, turn.user.text),
              ),
            ),
          );
        }

        for (const step of turn.steps) {
          const index = groups.findIndex(
            (entry) => entry.kind === "step" && entry.turn === turn.turn && entry.step === step,
          );
          const active = selection !== null && selection.kind === "step" && selection.index === index;
          const stepNo = step.displayStep === undefined ? step.step : step.displayStep;
          const stepKey = turn.turn + ":" + step.step;
          const lastStep = turn === turns[turns.length - 1] && step === turn.steps[turn.steps.length - 1];
          const live = step.status === "running" || step.live === true || (sessionRunning && lastStep);
          const sequence = Array.isArray(step.sequence) ? step.sequence : [];
          const reasoningTotal = sequence.filter((entry) => entry.kind === "reasoning").length;
          const reasoningCount = reasoningTotal;
          rows.push(
            h("div", { key: "s" + stepKey, style: GROUP_STYLE },
              h("div", {
                "data-fzl-group": String(index),
                "data-fzl-step-index": String(index),
                "data-fzl-turn": String(turn.turn),
                onClick: () => select({ kind: "step", index }),
                style: active ? GROUP_HEAD_ACTIVE_STYLE : GROUP_HEAD_STYLE,
              },
                h("span", { style: { minWidth: 0, whiteSpace: "normal" } },
                  t("traceStep", { step: stepNo }) + (traceSummary(step) === "" ? "" : " \u00b7 " + traceSummary(step))),
                h("span", { style: { color: MUTED, fontWeight: 400, flex: "none" } }, String(sequence.length)),
              ),
              sequence.map((entry, position) => {
                if (entry.kind === "reasoning") {
                  const key = stepKey + ":" + position;
                  const open = !wide && ((live && position === sequence.length - 1) || openReasoning.has(key));
                  return h("div", { key: "r" + key },
                    h("div", {
                      "data-fzl-row": "r" + key,
                      onClick: () => {
                        if (!wide) {
                          const next = new Set(openReasoning);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          setOpenReasoning(next);
                        }
                        select({ kind: "row", index, row: "reasoning", position });
                      },
                      style: open ? ROW_SELECTED_STYLE : ROW_STYLE,
                    },
                      h("span", { style: LINENO_STYLE }, ""),
                      h("span", { style: CHIP_STYLE("reasoning") }, t("kindThinking")),
                      h("span", { style: ROW_PRIMARY }, live ? t("running") : traceFirstLine(entry.text, 30)),
                      h("span", { style: rowSecondary() }, live ? "" : (reasoningCount === 0 ? "" : (position + 1) + "/" + reasoningTotal + " · ") + t("traceReasoningChars", { count: formatCount(entry.text.length) })),
                      h("span", { style: rowMeta() }, open ? "\u25be" : "\u25b8"),
                    ),
                    (() => {
                      if (!open) return null;
                      const zh = traceTranslation.get(entry.text);
                      const since = openedAt.current.get(key) ?? 0;
                      const ready = zh !== undefined && Date.now() - since >= 1200;
                      if (!ready) traceTranslation.request(entry.text, sessionId);
                      return h("div", {
                        style: {
                          padding: "2px 10px 8px 48px",
                          fontSize: 11,
                          lineHeight: 1.75,
                          color: ready ? "#1a56b0" : SECONDARY,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 260,
                          overflowY: "auto",
                          transition: "color 240ms ease",
                        },
                        ...(live ? { "data-fzl-live": "1" } : {}),
                      }, ready ? zh : entry.text);
                    })(),
                  );
                }
                if (entry.kind === "text") {
                  const key = "t" + stepKey + ":" + position;
                  return h("div", {
                    key: key,
                    "data-fzl-row": key,
                    style: { ...ROW_STYLE, cursor: "default", color: SECONDARY },
                  },
                    h("span", { style: LINENO_STYLE }, ""),
                    h("span", { style: CHIP_STYLE("assistant") }, t("kindAssistant")),
                    h("span", { style: rowSecondary() }, traceFirstLine(entry.text, 60)),
                    h("span", { style: rowMeta() }, ""),
                  );
                }
                const action = step.actions.find((candidate) => candidate.callId === entry.callId);
                const label = TRACE_TOOL_LABEL[traceCategory(entry.name)] ?? t("kindTool");
                const toolText = action === undefined ? entry.name : traceTarget(action);
                const toolZh = traceTranslation.get(toolText);
                if (cotEnabled && toolZh === undefined) traceTranslation.request(toolText, sessionId);
                return h("div", {
                  key: entry.callId,
                  "data-fzl-row": entry.callId,
                  onClick: () => select({ kind: "row", index, row: entry.callId }),
                  style: selection !== null && selection.kind === "row" && selection.row === entry.callId ? ROW_SELECTED_STYLE : ROW_STYLE,
                },
                  h("span", { style: LINENO_STYLE }, ""),
                  h("span", { style: CHIP_STYLE("tool") }, t("kindTool")),
                  h("span", { style: ROW_PRIMARY }, label),
                  h("span", { style: rowSecondary() }, toolZh === undefined ? toolText : toolZh),
                  h("span", { style: rowMeta(), ...(action !== undefined && action.status === "error" ? { color: "#b3261e" } : {}) },
                    action === undefined ? "" : action.status === "error" ? t("failed") : action.status === "running" ? t("running") : formatMs(action.ms)),
                );
              }),
            ),
          );
        }
      }

      if (groups.length === 0) {
        return h(
          "div",
          { ref: rootRef, "data-fzl-panel": "1", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, color: PRIMARY, fontSize: 12 } },
          h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + BORDER } },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, t("traceTitle")),
            h("div", { style: { marginTop: 2, fontSize: 10, color: SECONDARY } }, t("traceTotals", { turns: 0, rows: 0 })),
          ),
          h("div", { style: { padding: "16px", fontSize: 11.5, color: MUTED } }, modelError === "" ? t("traceEmpty") : "model error: " + modelError),
        );
      }

      return h(
        "div",
        { ref: rootRef, "data-fzl-panel": "1", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, color: PRIMARY, fontSize: 12 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "8px 14px 6px", borderBottom: "1px solid " + BORDER } },
          h("div", null,
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, t("traceTitle")),
            h("div", { style: { marginTop: 2, fontSize: 10, color: SECONDARY } }, t("traceTotals", { turns: turns.length, rows: groups.length })),
          ),
          h("button", {
            type: "button",
            onClick: () => setSettingsOpen(!settingsOpen),
            style: { padding: "1px 7px", border: "1px solid " + BORDER, borderRadius: 5, background: settingsOpen ? "#eef3f9" : "transparent", color: "#42566b", font: "inherit", fontSize: 9.5, cursor: "pointer" },
          }, t("traceSettings")),
        ),
        settingsOpen
          ? h("div", {
              style: {
                position: "absolute",
                top: 40,
                right: 8,
                zIndex: 80,
                width: 232,
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--dsw-alias-bg-layer-1, #fff)",
                border: "1px solid " + BORDER,
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
              },
            },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
                h("span", { style: { fontSize: 11 } }, t("traceIntercept")),
                ShippedSwitch === undefined
                  ? h("input", { type: "checkbox", checked: intercept, onChange: (event) => traceIntercept.set(event.target.checked) })
                  : h(ShippedSwitch, { checked: intercept, label: t("traceIntercept"), onChange: (next) => traceIntercept.set(next === true) })),
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
                h("span", { style: { fontSize: 11 } }, t("traceLines")),
                ShippedSwitch === undefined
                  ? h("input", { type: "checkbox", checked: lines, onChange: (event) => traceLines.set(event.target.checked) })
                  : h(ShippedSwitch, { checked: lines, label: t("traceLines"), onChange: (next) => traceLines.set(next === true) })),
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
                h("span", { style: { fontSize: 11 } }, t("traceCot")),
                ShippedSwitch === undefined
                  ? h("input", { type: "checkbox", checked: cotEnabled, onChange: (event) => traceTranslation.setEnabled(event.target.checked) })
                  : h(ShippedSwitch, { checked: cotEnabled, label: t("traceCot"), onChange: (next) => traceTranslation.setEnabled(next === true) })),
              h("div", { style: { fontSize: 9.5, color: MUTED } }, t("traceCotStatus", { status: traceTranslation.status() })),
            )
          : null,
        h(
          "div",
          { style: { display: "flex", flex: 1, minHeight: 0 } },
          h("div", { "data-fzl-list": "1", ref: listRef, onScroll: (event) => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }, style: { flex: wide ? "0 0 56%" : "1 1 auto", minWidth: 0, overflowY: "auto", padding: "6px 10px 12px" } }, rows),
          wide
            ? h("div", { style: { flex: "1 1 44%", minWidth: 0, overflowY: "auto", borderLeft: "1px solid " + BORDER, background: DETAIL_BG, padding: "10px 14px" } },
                h(TraceDetail, { t, selection, groups }))
            : null,
        ),
      );
    }

    const TURN_HEAD_STYLE = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      margin: "6px 0 2px",
      padding: "3px 8px",
      borderRadius: 4,
      background: "#eef3f9",
      color: "#42566b",
      fontSize: 11,
      fontWeight: 700,
      cursor: "pointer",
      userSelect: "none",
    };
    const TURN_HEAD_ACTIVE_STYLE = { ...TURN_HEAD_STYLE, background: "#dfe9fa", boxShadow: "inset 2px 0 0 #3b6fd4", color: "#234a8c" };
    const GROUP_STYLE = { marginBottom: 6 };
    const GROUP_HEAD_STYLE = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginLeft: 12,
      padding: "3px 8px",
      borderRadius: 4,
      background: "#f4f6f9",
      color: "#42566b",
      fontSize: 10.5,
      fontWeight: 700,
      cursor: "pointer",
    };
    const GROUP_HEAD_ACTIVE_STYLE = { ...GROUP_HEAD_STYLE, background: "#dfe9fa", boxShadow: "inset 2px 0 0 #3b6fd4", color: "#234a8c" };
    const ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      height: 34,
      padding: "0 6px 0 24px",
      borderBottom: "1px solid #f2f2f4",
      cursor: "pointer",
    };
    const ROW_SELECTED_STYLE = { ...ROW_STYLE, background: "#f5f7fa" };
    const LINENO_STYLE = { width: 22, textAlign: "right", fontFamily: "Consolas, monospace", fontSize: 9.5, color: "#a6abb3", flex: "none" };
    const CHIP_STYLE = (kind) => ({
      flex: "none",
      padding: "0 5px",
      borderRadius: 4,
      fontSize: 10,
      lineHeight: "16px",
      background: kind === "user" ? "#e8f0fe" : kind === "assistant" ? "#e6f4ea" : kind === "reasoning" ? "#eef0f2" : "#fdf1e3",
      color: kind === "user" ? "#1a56b0" : kind === "assistant" ? "#1e6b3a" : kind === "reasoning" ? "#4a4f57" : "#8a4b12",
    });
    const ROW_PRIMARY = { fontWeight: 600, fontSize: 11.5, whiteSpace: "nowrap", flex: "none" };
    const rowSecondary = () => ({ color: SECONDARY, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 });
    const rowMeta = () => ({ marginLeft: "auto", color: MUTED, fontSize: 10, whiteSpace: "nowrap", flex: "none" });

    const NS = "execLog";
    const ID = "@local/dsh-ui-exec-log";
    const KIND = "exec-log";

    /**
     * The shipped primitives table, resolved on first use.
     *
     * Module Loader packages get this table as a baseline external, which is how
     * the plugin page itself renders its switches. Resolving lazily keeps a build
     * without the table working: the feature rows fall back to a plain button
     * instead of failing.
     */
    let primitivesModule;
    function primitives() {
      if (primitivesModule !== undefined) return primitivesModule;
      try {
        primitivesModule = require("@deepseek-ai/dsh-client-ui-primitives") || null;
      } catch (error) {
        primitivesModule = null;
      }
      return primitivesModule;
    }

    /** Browser services this plugin needs. */
    const inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight", "jobs", "remote"];

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      "title": "执行轨迹",
      "guideTitle": "FZL的DSH优化集",
      "guideDescription": "执行轨迹 · 插件白话视图 · 会话删除",
      "toolkitNav": "FZL 优化集",
      "toolkitTitle": "FZL的DSH优化集",
      "toolkitDescription": "本插件的一组实用功能，逐项独立启停。",
      "feature.execLog": "执行轨迹",
      "feature.execLogHint": "右栏按轮次查看工具调用、耗时、token 与后台任务。",
      "feature.pluginView": "插件白话视图",
      "feature.pluginViewHint": "用白话说明替代官方插件页，可就地启停插件包。",
      "feature.sessionDelete": "会话删除",
      "feature.sessionDeleteHint": "列出本地会话；删除会同时清掉磁盘日志、内存常驻项与侧栏分组，不可恢复。",
      "featureOn": "已启用",
      "featureOff": "已停用",
      "featureEnable": "启用",
      "featureDisable": "停用",
      "featuresTitle": "功能开关",
      "featureToggle": "启用或停用「{name}」",
      "featureSummary": "{on}/{total} 项启用",
      "featuresMovedHint": "功能开关在「插件」页的本插件条目内；本页只管理会话。",
      "featureOffHint": "该功能已停用；在「插件」页的本插件条目内启用即可恢复。",
      "sessionsTitle": "会话管理",
      "sessionsHint": "删除会移除该会话的磁盘日志、投影缓存、内存常驻记录与侧栏分组，无法撤销。",
      "sessionsLoading": "读取会话中…",
      "sessionsEmpty": "没有可管理的会话。",
      "sessionsUnavailable": "宿主端未加载：重启 DSH 后此处才可删除会话。",
      "sessionsForbidden": "宿主拒绝了本次请求（来源校验未通过）。",
      "sessionsFailed": "读取失败：{reason}",
      "sessionsMeta": "{count} 个会话 · {size}",
      "sessionsRefresh": "刷新",
      "sessionUntitled": "未命名会话",
      "sessionDelete": "删除",
      "sessionDeleting": "删除中…",
      "sessionConfirm": "确认删除「{title}」？不可恢复。",
      "sessionConfirmYes": "确认删除",
      "sessionCancel": "取消",
      "sessionLive": "常驻内存",
      "sessionLiveHint": "该会话已在本进程加载；删除会一并移除内存记录、Agent 注册与侧栏分组。",
      "sessionBusy": "会话文件仍被进程占用（少见），重启 DSH 后再试",
      "menuDelete": "删除会话",
      "menuConfirmDelete": "确认删除？",
      "menuDeleteBusy": "删除中…",
      "sessionDeletedOne": "已删除「{title}」，释放 {size}",
      "sessionFailed": "删除失败：{reason}",
      "sessionArchived": "已归档",
      "sessionReloadHint": "侧栏通常立即移除该行；若仍有残留，刷新页面即可。",
      "reloadPage": "刷新页面",
      "empty": "还没有记录。对话产生第一个动作后，这里会按顺序列出。",
      "summary": "共 {turns} 轮 · {actions} 个动作",
      "turn": "第 {n} 轮",
      "tokensIn": "in {value}",
      "tokensOut": "out {value}",
      "running": "进行中",
      "error": "失败",
      "failed": "失败",
      "done": "已完成",
      "noData": "当前会话没有可读取的轨迹数据。",
      "step": "第 {n} 步",
      "ttft": "TTFT {value}",
      "details.input": "入参",
      "details.output": "出参",
      "details.error": "错误",
      "timeline": "时间轴",
      "imageCount": "图片 ×{count}",
      "noOutput": "无输出",
      "expand": "展开明细",
      "collapse": "收起明细",
      "chatAction": "执行细节",
      "locate": "在对话中定位",
      "locateDone": "已定位",
      "locateMissing": "对话中未找到",
      "reasoning": "思维链",
      "reasoningChars": "{value} 字",
      "jobs": "后台任务",
      "jobEmpty": "本会话暂无后台任务",
      "jobRunning": "运行中",
      "jobDone": "已完成",
      "jobFailed": "失败",
      "jobStopped": "已停止",
      "jobExit": "退出码 {code}",
      "jobWaiting": "等待输出…",
      "jobGap": "…较早的输出已丢弃…",
      "viewPlain": "白话视图",
      "viewOfficial": "官方视图",
      "viewSwitchAria": "切换插件管理视图",
      "tabLabel": "插件",
      "pluginsGuideTitle": "插件说明",
      "gLoading": "读取中…",
      "gEmpty": "没有可显示的插件包。",
      "gUnavailable": "当前配置不提供插件清单接口（插件管理器未就绪）。",
      "gError": "读取失败：{code}",
      "gOriginLink": "本地链接",
      "gOriginFile": "本地目录",
      "gOriginGit": "Git 源",
      "gOriginNpm": "npm 包",
      "gOriginBuiltin": "随安装包自带",
      "gRows": "插件行 {count}",
      "gOverrides": "改写官方配置 {count} 处",
      "gEnabled": "已启用",
      "gDisabled": "已停用",
      "gLocked": "不可停用（{reason}）",
      "gToggleOn": "启用",
      "gToggleOff": "停用",
      "gRevertHint": "回退：停用即恢复官方默认；本地链接的包可整包移除。",
      "traceTitle": "执行轨迹",
      "traceTotals": "{turns} 轮 · {rows} 步",
      "traceTurn": "第 {turn} 轮",
      "traceMessage": "消息",
      "traceStep": "第 {step} 步",
      "traceAssistant": "助手消息",
      "kindUser": "用户",
      "kindAssistant": "助手",
      "kindTool": "工具",
      "kindReasoning": "思维链",
      "kindThinking": "思考",
      "traceReasoningChars": "{count} 字",
      "traceSelect": "点选左侧步骤或行查看明细",
      "traceNoTools": "没有工具调用",
      "traceStatus": "状态",
      "traceDuration": "时长",
      "traceTokens": "Token",
      "traceCalls": "工具调用",
      "traceArgs": "参数",
      "traceResult": "结果",
      "traceNarrow": "全屏可看明细",
      "traceFullscreen": "全屏",
      "traceReload": "重载界面",
      "traceStepUnit": "步",
      "traceAnalyzing": "分析中",
      "traceAnalyzed": "已完成分析",
      "traceAnalyzeFailed": "分析失败",
      "traceRowUnit": "行",
      "traceToggle": "展开/收起这一轮",
      "traceIntercept": "接管步骤展开",
      "traceLines": "连线",
      "traceCot": "翻译",
      "traceSettings": "设置",
      "traceCotStatus": "翻译状态：{status}",
      "traceOn": "开",
      "traceOff": "关",
      "traceEmpty": "当前会话还没有可显示的轨迹；对话产生第一个步骤后出现。",
      "aboutNav": "关于 DSH",
      "aboutTitle": "关于 DSH",
      "aboutDescription": "这台机器上的 DSH 装在哪、数据放在哪、加载了哪些插件。",
      "aboutVersion": "版本",
      "aboutProfile": "配置档",
      "aboutRoot": "安装根",
      "aboutHome": "数据目录",
      "aboutRefresh": "重新扫描",
      "aboutScanning": "扫描中…",
      "aboutFramework": "文件框架",
      "aboutFrameworkHint": "点名称可收起或展开；这里只列关键位置，不逐个列文件。",
      "aboutComposition": "这个配置档加载了 {bundles} 个插件包、{patches} 条补丁",
      "aboutItems": "{count} 项",
      "aboutToggle": "点一下收起或展开",
      "aboutPluginError": "插件信息读取失败：{reason}",
      "aboutRole_root": "这一份 DSH 的全部内容都在这里；整个目录搬走也能继续用",
      "aboutRole_launcher": "双击它启动 DSH：会先把数据与运行环境指向本目录",
      "aboutRole_app": "程序本体；升级 DSH 时整块替换，不要手动改",
      "aboutRole_runtime": "DSH 的运行时和自带插件；平时不用动",
      "aboutRole_data": "所有会变的数据：设置、对话、凭据",
      "aboutRole_home": "你的数据都在这；备份或迁移只拷这一个目录",
      "aboutRole_profiles": "插件组合；每个配置档决定加载哪些插件",
      "aboutRole_profile": "当前使用的配置档；插件开关与补丁都记在这里",
      "aboutRole_sessions": "每次对话的记录；删掉这里等于删掉对话，不可恢复",
      "aboutRole_storages": "工作区清单与索引缓存；删掉会自动重建",
      "aboutRole_attachments": "你上传的图片与文件",
      "aboutRole_runtimes": "内置的 node / pnpm / python；重装依赖时会用到",
      "aboutRole_workspace": "项目文件；新建会话时选的就是这里",
      "aboutRenderFailed": "「关于 DSH」渲染失败：{reason}",
    };

    /** English dictionary, checked against the Chinese key set. */
    const en = {
      "title": "Execution Log",
      "guideTitle": "FZL's DSH Toolkit",
      "guideDescription": "Execution log · Plain plugin view · Session deletion",
      "toolkitNav": "FZL Toolkit",
      "toolkitTitle": "FZL's DSH Toolkit",
      "toolkitDescription": "A set of small utilities shipped by this package; each one switches on its own.",
      "feature.execLog": "Execution log",
      "feature.execLogHint": "Per-turn tool calls, timings, tokens and background jobs in the right Sidebar.",
      "feature.pluginView": "Plain plugin view",
      "feature.pluginViewHint": "Replaces the official Plugins page with plain-language rows and inline enable/disable.",
      "feature.sessionDelete": "Session deletion",
      "feature.sessionDeleteHint": "Lists local Sessions; deleting clears the on-disk log, the in-memory entry and the Sidebar group. Not recoverable.",
      "featureOn": "enabled",
      "featureOff": "disabled",
      "featureEnable": "Enable",
      "featureDisable": "Disable",
      "featuresTitle": "Feature switches",
      "featureToggle": "Enable or disable {name}",
      "featureSummary": "{on}/{total} enabled",
      "featuresMovedHint": "The feature switches live on this plugin's entry in the Plugins page; this page manages Sessions only.",
      "featureOffHint": "This feature is off; enable it on this plugin's entry in the Plugins page.",
      "sessionsTitle": "Session manager",
      "sessionsHint": "Deleting removes the Session's log directory, projection cache, in-memory record and Sidebar group. There is no undo.",
      "sessionsLoading": "Reading sessions...",
      "sessionsEmpty": "No Sessions to manage.",
      "sessionsUnavailable": "Host half not loaded: restart DSH before deleting Sessions here.",
      "sessionsForbidden": "The Host refused this request (origin check failed).",
      "sessionsFailed": "Could not read: {reason}",
      "sessionsMeta": "{count} sessions · {size}",
      "sessionsRefresh": "Refresh",
      "sessionUntitled": "Untitled session",
      "sessionDelete": "Delete",
      "sessionDeleting": "Deleting...",
      "sessionConfirm": "Delete “{title}”? This cannot be undone.",
      "sessionConfirmYes": "Delete",
      "sessionCancel": "Cancel",
      "sessionLive": "loaded in memory",
      "sessionLiveHint": "This session is resident in the current process; deleting also drops its in-memory record, Agent registration and Sidebar group.",
      "sessionBusy": "Session files are still held by the process (rare); restart DSH and retry",
      "menuDelete": "Delete session",
      "menuConfirmDelete": "Delete?",
      "menuDeleteBusy": "Deleting...",
      "sessionDeletedOne": "Deleted “{title}”, freed {size}",
      "sessionFailed": "Delete failed: {reason}",
      "sessionArchived": "archived",
      "sessionReloadHint": "The Sidebar normally drops the row at once; reload the page if anything is left.",
      "reloadPage": "Reload page",
      "empty": "No records yet. Actions will be listed here once the conversation produces one.",
      "summary": "{turns} turns · {actions} actions",
      "turn": "Turn {n}",
      "tokensIn": "in {value}",
      "tokensOut": "out {value}",
      "running": "running",
      "error": "failed",
      "failed": "failed",
      "done": "completed",
      "noData": "This session exposes no trajectory data.",
      "step": "Step {n}",
      "ttft": "TTFT {value}",
      "details.input": "Input",
      "details.output": "Output",
      "details.error": "Error",
      "timeline": "Timeline",
      "imageCount": "{count} images",
      "noOutput": "No output",
      "expand": "Show details",
      "collapse": "Hide details",
      "chatAction": "Execution details",
      "locate": "Locate in chat",
      "locateDone": "Located",
      "locateMissing": "Not found in chat",
      "reasoning": "Reasoning",
      "reasoningChars": "{value} chars",
      "jobs": "Background jobs",
      "jobEmpty": "No background jobs in this session",
      "jobRunning": "running",
      "jobDone": "done",
      "jobFailed": "failed",
      "jobStopped": "stopped",
      "jobExit": "exit {code}",
      "jobWaiting": "Waiting for output...",
      "jobGap": "...older output was dropped...",
      "viewPlain": "Plain view",
      "viewOfficial": "Official view",
      "viewSwitchAria": "Switch plugin-management view",
      "tabLabel": "Plugins",
      "pluginsGuideTitle": "Plugin guide",
      "gLoading": "Reading...",
      "gEmpty": "No plugin bundles to show.",
      "gUnavailable": "This configuration exposes no plugin inventory (the plugin manager is not ready).",
      "gError": "Could not read: {code}",
      "gOriginLink": "local link",
      "gOriginFile": "local directory",
      "gOriginGit": "Git source",
      "gOriginNpm": "npm package",
      "gOriginBuiltin": "ships with the installation",
      "gRows": "{count} plugin rows",
      "gOverrides": "{count} official overrides",
      "gEnabled": "enabled",
      "gDisabled": "disabled",
      "gLocked": "cannot be disabled ({reason})",
      "gToggleOn": "Enable",
      "gToggleOff": "Disable",
      "gRevertHint": "Undo: disabling restores the official default; a locally linked bundle can be removed entirely.",
      "traceTitle": "Execution log",
      "traceTotals": "{turns} turns · {rows} steps",
      "traceTurn": "Turn {turn}",
      "traceMessage": "message",
      "traceStep": "step {step}",
      "traceAssistant": "Assistant message",
      "kindUser": "User",
      "kindAssistant": "Assistant",
      "kindTool": "Tool",
      "kindReasoning": "Reasoning",
      "kindThinking": "Thinking",
      "traceReasoningChars": "{count} chars",
      "traceSelect": "Select a step or row on the left to see details",
      "traceNoTools": "no tool calls",
      "traceStatus": "Status",
      "traceDuration": "Duration",
      "traceTokens": "Token",
      "traceCalls": "Tool calls",
      "traceArgs": "Arguments",
      "traceResult": "Result",
      "traceNarrow": "Fullscreen for details",
      "traceFullscreen": "Fullscreen",
      "traceReload": "Reload UI",
      "traceStepUnit": "steps",
      "traceAnalyzing": "analyzing",
      "traceAnalyzed": "analysis complete",
      "traceAnalyzeFailed": "analysis failed",
      "traceRowUnit": "rows",
      "traceToggle": "Expand or collapse this turn",
      "traceIntercept": "Take over step expansion",
      "traceLines": "Connectors",
      "traceCot": "Translate",
      "traceSettings": "Settings",
      "traceCotStatus": "Translation: {status}",
      "traceOn": "on",
      "traceOff": "off",
      "traceEmpty": "No steps to show yet; the first step of this conversation will appear here.",
      "aboutNav": "About DSH",
      "aboutTitle": "About DSH",
      "aboutDescription": "Where DSH lives on this machine, where your data sits, and which plugins are loaded.",
      "aboutVersion": "Version",
      "aboutProfile": "Profile",
      "aboutRoot": "Install root",
      "aboutHome": "Data home",
      "aboutRefresh": "Rescan",
      "aboutScanning": "Scanning...",
      "aboutFramework": "File framework",
      "aboutFrameworkHint": "Click a name to fold or unfold it; only the places that matter are listed, not every file.",
      "aboutComposition": "This profile loads {bundles} bundles and {patches} patch rows",
      "aboutItems": "{count} items",
      "aboutToggle": "Click to fold or unfold",
      "aboutPluginError": "Could not read the plugin facts: {reason}",
      "aboutRole_root": "Everything that makes up this DSH; the whole folder still works after it moves",
      "aboutRole_launcher": "Double-click it to start DSH: it points the data and runtime at this folder first",
      "aboutRole_app": "The application itself; replace it whole when upgrading, never by hand",
      "aboutRole_runtime": "The DSH runtime and its built-in plugins; you rarely touch this",
      "aboutRole_data": "Everything that changes: settings, conversations, credentials",
      "aboutRole_home": "All your data lives here; back up or migrate this folder only",
      "aboutRole_profiles": "Plugin compositions; each profile decides which plugins load",
      "aboutRole_profile": "The profile in use; plugin switches and patches are recorded here",
      "aboutRole_sessions": "One record per conversation; deleting it deletes the conversation for good",
      "aboutRole_storages": "Workspace list and index cache; safe to rebuild if removed",
      "aboutRole_attachments": "Images and files you uploaded",
      "aboutRole_runtimes": "Bundled node / pnpm / python; used when reinstalling dependencies",
      "aboutRole_workspace": "Your project files; this is what a new Session opens in",
      "aboutRenderFailed": "The About DSH page failed to render: {reason}",
    };

    /** Argument keys worth showing as an action's target text, in priority order. */
    const TARGET_KEYS = [
      "file_path",
      "filePath",
      "path",
      "pattern",
      "glob",
      "command",
      "query",
      "url",
      "prompt",
      "session_id",
      "sessionId",
      "name",
      "service",
    ];

    /** Guide glyph: an activity list, inheriting the host's currentColor. */
    function ExecLogIcon(props) {
      const size = props && props.size ? props.size : 24;
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          "aria-hidden": true,
          style: { display: "block", pointerEvents: "none" },
        },
        h("rect", {
          x: 2.75,
          y: 3.75,
          width: 18.5,
          height: 16.5,
          rx: 3.25,
          stroke: "currentColor",
          strokeWidth: 1.5,
        }),
        h("path", {
          d: "M6.5 9h6M6.5 12.5h8M6.5 16h5",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        }),
      );
    }

    /** Tab chip text. */
    function ExecLogTitle(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      return h(
        "span",
        {
          style: {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          },
        },
        t("title"),
      );
    }

    /** Milliseconds in the trajectory ledger's own unit style. */
    function formatMs(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
      if (ms < 1000) return Math.round(ms) + "ms";
      return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
    }

    /** Token counts, shortened once they exceed a thousand. */
    function formatCount(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      if (value < 1000) return String(value);
      if (value < 1e6) return (value / 1000).toFixed(1) + "k";
      return (value / 1e6).toFixed(2) + "M";
    }

    /** Epoch-ms as a local wall clock with milliseconds, for the timeline row. */
    function formatClock(timestamp) {
      const value = usableTime(timestamp);
      if (value === null) return "";
      const date = new Date(value);
      const two = (part) => String(part).padStart(2, "0");
      return (
        two(date.getHours()) +
        ":" +
        two(date.getMinutes()) +
        ":" +
        two(date.getSeconds()) +
        "." +
        String(date.getMilliseconds()).padStart(3, "0")
      );
    }

    /** Pretty JSON when the text parses, otherwise the raw text unchanged. */
    function prettyJson(text) {
      if (typeof text !== "string" || text.trim() === "") return "";
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch (error) {
        return text;
      }
    }

    /**
     * Read the displayable outcome of a tool result.
     * @param result - a `tool-result` node, or undefined while the call is in flight.
     * @returns `{ output, imageCount, errorLabel }`; empty strings mean "nothing to show".
     */
    function readResult(result) {
      if (result === null || result === undefined) return { output: "", imageCount: 0, errorLabel: null };
      if (result.isError === true) {
        const error = result.error;
        if (error === null || error === undefined) return { output: "", imageCount: 0, errorLabel: "error" };
        return {
          output: "",
          imageCount: 0,
          errorLabel: (error.name === undefined ? "error" : error.name) + ": " + (error.code === undefined ? "" : error.code),
        };
      }
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      const imageCount = blocks.filter(
        (block) => block !== null && typeof block === "object" && (block.type === "image" || block.type === "file"),
      ).length;
      if (text !== "") return { output: text, imageCount, errorLabel: null };
      if (imageCount === 0 && blocks.length > 0) {
        return { output: prettyJson(JSON.stringify(blocks)), imageCount: 0, errorLabel: null };
      }
      return { output: "", imageCount, errorLabel: null };
    }

    /** One-line target text out of a tool call's raw JSON arguments. */
    function targetOf(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw.trim() === "") return "";
      let text = "";
      try {
        const parsed = JSON.parse(argsRaw);
        if (parsed !== null && typeof parsed === "object") {
          for (const key of TARGET_KEYS) {
            const value = parsed[key];
            if (typeof value === "string" && value !== "") {
              text = value;
              break;
            }
          }
          if (text === "") {
            for (const value of Object.values(parsed)) {
              if (typeof value === "string" && value !== "") {
                text = value;
                break;
              }
            }
          }
        }
      } catch (error) {
        text = argsRaw;
      }
      text = text.replace(/\s+/g, " ").trim();
      return text.length > 90 ? text.slice(0, 89) + "..." : text;
    }

    /** Whether a timestamp is a usable epoch-ms value. */
    function usableTime(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /**
     * Fold a trajectory snapshot into the panel's turn rows.
     *
     * Turn attribution is authoritative on `requests` (tool-result nodes carry no
     * turn), and each request's `usage` is that step's own use, so summing the
     * requests of a turn yields the turn's tokens. Assistant nodes supply the action
     * order and the call/result pairing; `runningCalls` (minus the "preparing"
     * phase) supply calls whose result has not arrived.
     *
     * @param snapshot - `useTrajectory` inspection snapshot, or undefined before load.
     * @returns an array of turns in ascending turn order, each with its actions.
     */
    function buildTurns(snapshot) {
      if (snapshot === null || snapshot === undefined) return [];
      const nodes = Array.isArray(snapshot.eventNodes) ? snapshot.eventNodes : [];
      const results = new Map();
      for (const node of nodes) {
        if (node.kind === "tool-result" && node.parentCallId === undefined) results.set(node.callId, node);
      }
      const byTurn = new Map();
      const order = [];
      const seenCalls = new Set();
      const turnOf = (turn) => {
        const key = typeof turn === "number" ? turn : 0;
        let entry = byTurn.get(key);
        if (entry === undefined) {
          entry = {
            turn: key,
            actions: [],
            steps: [],
            stepsByStep: new Map(),
            startedAt: null,
            completedAt: null,
            input: 0,
            output: 0,
            hasUsage: false,
            hasRequests: false,
            running: false,
            failed: false,
          };
          byTurn.set(key, entry);
          order.push(entry);
        }
        return entry;
      };
      const runningCalls = Array.isArray(snapshot.runningCalls) ? snapshot.runningCalls : [];
      const runningById = new Map();
      for (const call of runningCalls) {
        if (call.phase === "preparing") continue; // dispatched, but not started yet
        runningById.set(call.callId, call);
      }
      const stepOf = (entry, stepNumber) => {
        let step = entry.stepsByStep.get(stepNumber);
        if (step === undefined) {
          step = {
            step: stepNumber,
            startedAt: null,
            completedAt: null,
            status: "complete",
            input: null,
            output: null,
            ttftMs: null,
            reasoning: "",
            sequence: [],
            title: "",
            preview: "",
            seq: null,
          };
          entry.steps.push(step);
          entry.stepsByStep.set(stepNumber, step);
        }
        return step;
      };

      // 1. Turn facts: timing, tokens and state come from the step requests.
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      for (const request of requests) {
        if (request.purpose !== undefined && request.purpose !== "assistant") continue;
        const entry = turnOf(request.turn);
        entry.hasRequests = true;
        const usage = request.usage;
        const usedInput =
          usage !== undefined && usage !== null && typeof usage.inputTokens === "number" ? usage.inputTokens : null;
        const usedOutput =
          usage !== undefined && usage !== null && typeof usage.outputTokens === "number" ? usage.outputTokens : null;
        if (usage !== undefined && usage !== null) {
          entry.hasUsage = true;
          entry.input += usedInput === null ? 0 : usedInput;
          entry.output += usedOutput === null ? 0 : usedOutput;
        }
        const started = usableTime(request.startedAt);
        if (started !== null) entry.startedAt = entry.startedAt === null ? started : Math.min(entry.startedAt, started);
        const completed = usableTime(request.completedAt);
        if (completed !== null) entry.completedAt = entry.completedAt === null ? completed : Math.max(entry.completedAt, completed);
        else entry.running = true;
        if (request.status === "error") entry.failed = true;
        const stepNumber = typeof request.step === "number" ? request.step : 0;
        const step = stepOf(entry, stepNumber);
        step.startedAt = started;
        step.completedAt = completed;
        step.status = request.status === undefined ? "complete" : request.status;
        step.input = usedInput;
        step.output = usedOutput;
      }

      // 2. Actions and reasoning, in event order, paired with their results.
      for (const node of nodes) {
        if (node.kind === "user") {
          const entry = turnOf(node.turn);
          const blocks = Array.isArray(node.blocks) ? node.blocks : [];
          const first = blocks.find((block) => block.kind === "text" && typeof block.text === "string" && block.text.trim() !== "");
          const text = first !== undefined ? first.text : typeof node.text === "string" ? node.text : "";
          if (entry.user === undefined && text !== "") entry.user = { seq: node.seq, text: traceFirstLine(text, 60) };
          continue;
        }
        if (node.kind !== "assistant") continue;
        const entry = turnOf(node.turn);
        const stepNumber = typeof node.step === "number" ? node.step : 0;
        const blocks = Array.isArray(node.blocks) ? node.blocks : [];
        const stepEntry = stepOf(entry, stepNumber);
        if (stepEntry.seq === null && typeof node.seq === "number") stepEntry.seq = node.seq;
        for (const block of blocks) {
          if (block.kind === "reasoning" && typeof block.text === "string" && block.text !== "") {
            stepEntry.sequence.push({ kind: "reasoning", text: block.text });
          } else if (block.kind === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            stepEntry.sequence.push({ kind: "text", text: block.text });
          } else if (block.kind === "tool-call") {
            stepEntry.sequence.push({ kind: "tool", callId: block.callId, name: block.name });
          }
        }
        for (const block of blocks) {
          if (block.kind !== "text" || typeof block.text !== "string") continue;
          const line = traceFirstLine(block.text, 34);
          if (line === "") continue;
          if (stepEntry.title === "") stepEntry.title = line;
          else if (stepEntry.preview === "") stepEntry.preview = line;
        }
        let reasoning = "";
        for (const block of blocks) {
          if (block.kind === "reasoning" && typeof block.text === "string" && block.text !== "") {
            reasoning = reasoning === "" ? block.text : reasoning + "\n\n" + block.text;
          }
        }
        if (reasoning !== "") {
          const step = stepOf(entry, stepNumber);
          step.reasoning = step.reasoning === "" ? reasoning : step.reasoning + "\n\n" + reasoning;
        }
        for (const block of blocks) {
          if (block.kind !== "tool-call") continue;
          const result = results.get(block.callId);
          const inFlight = result === undefined ? runningById.get(block.callId) : undefined;
          const outcome = readResult(result);
          seenCalls.add(block.callId);
          entry.actions.push({
            callId: block.callId,
            name: block.name,
            step: typeof node.step === "number" ? node.step : 0,
            messageId: typeof node.messageId === "string" ? node.messageId : null,
            target: targetOf(block.argsRaw),
            status: result === undefined ? "running" : result.isError === true ? "error" : "ok",
            ms: result === undefined ? null : durationOf(result.time, result.callTime),
            callTime: usableTime(result === undefined ? (inFlight === undefined ? undefined : inFlight.time) : result.callTime),
            time: result === undefined ? null : usableTime(result.time),
            argsRaw:
              typeof block.argsRaw === "string"
                ? block.argsRaw
                : inFlight !== undefined && typeof inFlight.argsRaw === "string"
                  ? inFlight.argsRaw
                  : "",
            output: outcome.output,
            imageCount: outcome.imageCount,
            errorLabel: outcome.errorLabel,
          });
        }
        const timing = node.timing;
        if (timing !== undefined && timing !== null) {
          const first = usableTime(timing.firstTokenTime);
          const stepStart = usableTime(timing.stepStartTime);
          if (first !== null && stepStart !== null) {
            const step = entry.stepsByStep.get(node.step);
            if (step !== undefined && step.ttftMs === null) step.ttftMs = Math.max(0, first - stepStart);
          }
        }
        // Fallbacks for a snapshot without request records (trimmed history).
        if (!entry.hasRequests) {
          const started = usableTime(timing === undefined || timing === null ? undefined : timing.stepStartTime);
          if (started !== null && (entry.startedAt === null || started < entry.startedAt)) entry.startedAt = started;
          const completed = usableTime(node.time);
          if (completed !== null && (entry.completedAt === null || completed > entry.completedAt)) entry.completedAt = completed;
          const usage = node.usage;
          if (!entry.hasUsage && usage !== undefined && usage !== null) {
            entry.hasUsage = true;
            entry.input += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
            entry.output += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
          }
        }
      }

      // 3. Calls still in flight that no assistant block mentioned yet.
      for (const call of runningById.values()) {
        if (seenCalls.has(call.callId)) continue;
        seenCalls.add(call.callId);
        turnOf(call.turn).actions.push({
          callId: call.callId,
          name: call.name,
          step: typeof call.step === "number" ? call.step : 0,
          messageId: null,
          target: targetOf(call.argsRaw),
          status: "running",
          ms: null,
          callTime: usableTime(call.time),
          time: null,
          argsRaw: typeof call.argsRaw === "string" ? call.argsRaw : "",
          output: "",
          imageCount: 0,
          errorLabel: null,
        });
      }

      // The in-progress step is not a settled node yet: its blocks arrive per
      // chunk, exactly the stream the conversation renders while generating.
      const partial = snapshot.partial;
      if (partial !== null && partial !== undefined && Array.isArray(partial.blocks)) {
        const entry = turnOf(partial.turn);
        const step = stepOf(entry, typeof partial.step === "number" ? partial.step : 0);
        step.live = true;
        for (const block of partial.blocks) {
          if (block.kind === "reasoning" && typeof block.text === "string" && block.text !== "") {
            step.sequence.push({ kind: "reasoning", text: block.text });
            step.reasoning = step.reasoning === "" ? block.text : step.reasoning + "\n\n" + block.text;
          } else if (block.kind === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            step.sequence.push({ kind: "text", text: block.text });
            const line = traceFirstLine(block.text, 34);
            if (step.title === "") step.title = line;
            else if (step.preview === "") step.preview = line;
          } else if (block.kind === "tool-call") {
            step.sequence.push({ kind: "tool", callId: block.callId, name: block.name });
            if (!entry.actions.some((action) => action.callId === block.callId)) {
              entry.actions.push({
                callId: block.callId,
                name: block.name,
                step: typeof partial.step === "number" ? partial.step : 0,
                messageId: null,
                target: targetOf(typeof block.argsRaw === "string" ? block.argsRaw : ""),
                status: "running",
                ms: null,
                callTime: null,
                time: null,
                argsRaw: typeof block.argsRaw === "string" ? block.argsRaw : "",
                output: "",
                imageCount: 0,
                errorLabel: null,
              });
            }
          }
        }
      }

      for (const entry of order) {
        entry.steps.sort((left, right) => left.step - right.step);
        for (const step of entry.steps) step.actions = entry.actions.filter((action) => action.step === step.step);
      }
      return order.sort((left, right) => left.turn - right.turn);
    }

    /** Duration between a result and its call start, both epoch-ms. */
    function durationOf(time, callTime) {
      const later = usableTime(time);
      const earlier = usableTime(callTime);
      if (later === null || earlier === null) return null;
      return Math.max(0, later - earlier);
    }

    /**
     * Reveal one tool call inside the conversation view.
     *
     * The conversation owns no navigation API for this - its `openView` /
     * `inspectCall` callbacks are handed only to the `conversation.view` slot owner -
     * so this uses the shipped DOM contract instead.
     *
     * In compact mode a tool row usually sits inside a collapsed process group, and a
     * hidden row cannot be scrolled to; the visible thing is the group's own status
     * header, so that is what gets revealed. A call outside the loaded history window
     * is reported as missing.
     *
     * @param callId - the tool call to reveal.
     * @returns whether a conversation anchor was found.
     */
    function revealCallInChat(callId) {
      if (typeof document === "undefined" || typeof callId !== "string" || callId === "") return false;
      const escape =
        typeof CSS !== "undefined" && CSS !== null && typeof CSS.escape === "function"
          ? CSS.escape
          : (value) => value.replace(/["\\]/g, "\\$&");
      const row = document.querySelector('[data-chat-call-id="' + escape(callId) + '"]');
      if (row === null || row === undefined) return false;
      let target = row;
      const group = typeof row.closest === "function" ? row.closest("[data-step-process]") : null;
      if (group !== null && group !== undefined) {
        // Inside a process group: aim at its header, which stays visible when folded.
        const header = typeof group.querySelector === "function" ? group.querySelector("button") : null;
        target = header === null || header === undefined ? group : header;
      } else if (
        typeof row.closest === "function" &&
        (row.closest("[data-turn-process-hidden]") !== null || row.offsetParent === null)
      ) {
        // A folded completed turn keeps its members hidden behind the turn's own row.
        const flow = row.closest("[data-chat-turn]");
        const turn = flow === null || flow === undefined || flow.dataset === undefined ? undefined : flow.dataset.chatTurn;
        if (turn !== undefined && typeof document.querySelectorAll === "function") {
          for (const candidate of document.querySelectorAll("[data-turn-process]")) {
            if (candidate.dataset !== undefined && candidate.dataset.chatTurn === turn) {
              target = candidate;
              break;
            }
          }
        }
      }
      const reveal = () => {
        if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center", behavior: "smooth" });
        if (typeof target.animate === "function") {
          target.animate(
            [
              { outline: "2px solid transparent" },
              { outline: "2px solid var(--dsw-alias-state-focus, #4c8dff)", offset: 0.15 },
              { outline: "2px solid transparent" },
            ],
            { duration: 1600, easing: "ease-out" },
          );
        }
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
      else reveal();
      return true;
    }

    /**
     * Send a click on the conversation's own process row to this panel instead.
     *
     * Compact mode leaves one live status row and one completed-turn row in the
     * conversation; both are disclosure toggles. Their `data-step-process` (live) and
     * `data-turn-process` (completed) markers are the shipped hook into them, and the
     * enclosing `[data-chat-turn]` says which turn the row belongs to.
     *
     * A click inside an already-expanded body is left alone, so links and text there
     * keep working.
     *
     * @param event - the DOM click event.
     * @param openPanel - callback receiving `{ turn }`, or undefined when unknown.
     * @returns whether the click was redirected.
     */
    function redirectProcessClick(event, openPanel) {
      const target = event === null || event === undefined ? undefined : event.target;
      if (target === null || target === undefined || typeof target.closest !== "function") return false;
      const row = target.closest("[data-turn-process],[data-step-process]");
      if (row === null || row === undefined) return false;
      if (target.closest("[data-step-process-body]") !== null) return false;
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      const flow = typeof row.closest === "function" ? row.closest("[data-chat-turn]") : null;
      const raw = flow === null || flow === undefined || flow.dataset === undefined ? undefined : flow.dataset.chatTurn;
      const turn = raw === undefined || raw === null || raw === "" ? undefined : Number(raw);
      // A live row is one step's process group: its position among that turn's groups
      // is the step's index inside the turn.
      let stepIndex;
      const isStepRow = typeof row.hasAttribute === "function" && row.hasAttribute("data-step-process");
      if (isStepRow && turn !== undefined && Number.isFinite(turn)) {
        const scope =
          typeof row.closest === "function" && row.closest('[data-slot="conversation.chat.flow"]') !== null
            ? row.closest('[data-slot="conversation.chat.flow"]')
            : typeof document === "undefined"
              ? null
              : document;
        if (scope !== null && typeof scope.querySelectorAll === "function") {
          const sameTurn = [];
          for (const candidate of scope.querySelectorAll("[data-step-process]")) {
            if (candidate.dataset !== undefined && candidate.dataset.chatTurn === String(turn)) sameTurn.push(candidate);
          }
          const index = sameTurn.indexOf(row);
          if (index >= 0) stepIndex = index;
        }
      }
      if (typeof openPanel === "function") {
        if (turn === undefined || !Number.isFinite(turn)) openPanel(undefined);
        else if (stepIndex === undefined) openPanel({ turn: turn });
        else openPanel({ turn: turn, stepIndex: stepIndex });
      }
      return true;
    }

    const MUTED = "var(--dsw-alias-label-tertiary)";
    const SECONDARY = "var(--dsw-alias-label-secondary)";
    const PRIMARY = "var(--dsw-alias-label-primary)";

    /** Panel surfaces and separators, shared with the host's theme tokens. */
    const BORDER = "var(--dsw-alias-border-l3)";
    const DETAIL_BG = "var(--dsw-alias-bg-layer-1)";
    const MONO_BG = "var(--dsw-alias-bg-layer-2, #f6f7f9)";

    /** Status dot: the only colour the panel spends on state. */
    const PLUGIN_VIEW_KEY = "dsh-exec-log.pluginView";

    /**
     * Which plugin-management view the settings tab shows.
     *
     * `plain` renders this plugin's plain-language page in the official tab's cell;
     * `official` withdraws that registration, so the shipped page returns. The choice
     * is kept in `localStorage` because it is a display preference, not session state.
     */
    const pluginViews = (() => {
      const listeners = new Set();
      let value = "plain";
      try {
        if (typeof localStorage !== "undefined" && localStorage !== null) {
          const saved = localStorage.getItem(PLUGIN_VIEW_KEY);
          if (saved === "plain" || saved === "official") value = saved;
        }
      } catch (error) {
        // Storage may be unavailable; the in-memory default stands.
      }
      return {
        get: () => value,
        set: (next) => {
          if (next !== "plain" && next !== "official") return;
          if (next === value) return;
          value = next;
          try {
            if (typeof localStorage !== "undefined" && localStorage !== null) {
              localStorage.setItem(PLUGIN_VIEW_KEY, next);
            }
          } catch (error) {
            // A failed write only costs persistence.
          }
          for (const listener of [...listeners]) listener(value);
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    /** Subscribe a component to the plugin-view preference. */
    function usePluginView() {
      const [value, setValue] = useState(pluginViews.get);
      useEffect(() => pluginViews.subscribe(setValue), []);
      return value;
    }

    /** Storage key of the per-feature enable list. */
    const FEATURE_KEY = "dsh-exec-log.features";

    /** The toolkit's features, in display order. */
    const FEATURE_IDS = ["execLog", "sessionDelete"];

    /**
     * Which toolkit features are switched on.
     *
     * This package is one plugin with several independent features. A switch is a
     * display preference rather than session state, so the choice lives in
     * `localStorage`, and every change re-registers or withdraws that feature's
     * seats live - no reload, no restart.
     */
    const featureFlags = (() => {
      const listeners = new Set();
      let value = { execLog: true, sessionDelete: true };
      try {
        if (typeof localStorage !== "undefined" && localStorage !== null) {
          const saved = JSON.parse(localStorage.getItem(FEATURE_KEY) || "null");
          if (saved !== null && typeof saved === "object") {
            for (const id of FEATURE_IDS) {
              if (typeof saved[id] === "boolean") value[id] = saved[id];
            }
          }
        }
      } catch (error) {
        // Storage may be unavailable; every feature stays on.
      }
      const snapshot = () => ({ ...value });
      return {
        get: snapshot,
        enabled: (id) => value[id] !== false,
        set: (id, next) => {
          if (!FEATURE_IDS.includes(id)) return;
          if (value[id] === next) return;
          value = { ...value, [id]: next };
          try {
            if (typeof localStorage !== "undefined" && localStorage !== null) {
              localStorage.setItem(FEATURE_KEY, JSON.stringify(value));
            }
          } catch (error) {
            // A failed write only costs persistence.
          }
          for (const listener of [...listeners]) listener(snapshot());
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    /** Subscribe a component to the feature switches. */
    function useFeatures() {
      const [value, setValue] = useState(featureFlags.get);
      useEffect(() => featureFlags.subscribe(setValue), []);
      return value;
    }

    /** Dispose every collected registration, tolerating one that already went away. */
    function combine(disposers) {
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch (error) {
            // A registration that removed itself is not a failure.
          }
        }
      };
    }

    /**
     * Mount one switchable feature and follow its switch.
     *
     * `register` mounts the feature's seats and returns their combined disposer.
     * The switch is read now and on every change, so turning a feature off
     * withdraws exactly that feature's registrations while the others stay live.
     *
     * @param ctx - client root context.
     * @param id - feature identity in {@link FEATURE_IDS}.
     * @param register - mounts the feature, returning one combined disposer.
     * @param label - effect label for the Host's effect table.
     */
    function gateFeature(ctx, id, register, label) {
      ctx.effect(() => {
        let dispose;
        const sync = () => {
          if (dispose !== undefined) {
            const previous = dispose;
            dispose = undefined;
            previous();
          }
          if (!featureFlags.enabled(id)) return;
          dispose = register();
        };
        const unsubscribe = featureFlags.subscribe(sync);
        sync();
        return () => {
          unsubscribe();
          if (dispose !== undefined) {
            const previous = dispose;
            dispose = undefined;
            previous();
          }
        };
      }, label);
    }

    /** One segment of the view switch. */
    function ViewSegment(props) {
      const active = props.active === true;
      return h(
        "button",
        {
          type: "button",
          "aria-pressed": active,
          onClick: props.onSelect,
          style: {
            padding: "2px 10px",
            border: "none",
            background: active ? "var(--dsw-alias-bg-layer-1)" : "transparent",
            color: active ? PRIMARY : MUTED,
            font: "inherit",
            fontSize: 11.5,
            lineHeight: 1.8,
            cursor: "pointer",
            boxShadow: active ? "inset 0 0 0 0.5px var(--dsw-alias-border-l3)" : undefined,
          },
        },
        props.label,
      );
    }

    /** The official/plain switch, mounted in the settings header's action area. */
    function PluginViewSwitch(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const value = usePluginView();
      return h(
        "div",
        {
          role: "group",
          "aria-label": t("viewSwitchAria"),
          style: {
            display: "inline-flex",
            alignItems: "center",
            border: "0.5px solid var(--dsw-alias-border-l3)",
            borderRadius: 999,
            overflow: "hidden",
          },
        },
        h(ViewSegment, {
          label: t("viewPlain"),
          active: value === "plain",
          onSelect: () => pluginViews.set("plain"),
        }),
        h(ViewSegment, {
          label: t("viewOfficial"),
          active: value === "official",
          onSelect: () => pluginViews.set("official"),
        }),
      );
    }

    /** Plain-language names for a bundle's install source scheme. */
    const ORIGIN_KEYS = { link: "gOriginLink", file: "gOriginFile", git: "gOriginGit", npm: "gOriginNpm" };

    /**
     * Normalize the plugin manager's bundle list into the facts this page narrates.
     *
     * @param bundles - `remote.pluginManager.listBundles()` rows.
     * @returns one record per bundle, with counts instead of raw patch structures.
     */
    function pluginGuideRows(bundles) {
      if (!Array.isArray(bundles)) return [];
      return bundles.map((bundle) => {
        const source = typeof bundle.source === "string" ? bundle.source : "";
        const scheme = source.includes(":") ? source.slice(0, source.indexOf(":")) : "";
        const origin =
          ORIGIN_KEYS[scheme] !== undefined
            ? ORIGIN_KEYS[scheme]
            : bundle.availability === "installation"
              ? "gOriginBuiltin"
              : "gOriginNpm";
        const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
        const overrides = Array.isArray(bundle.overrides) ? bundle.overrides : [];
        return {
          id: String(bundle.name),
          name: String(bundle.name),
          version: typeof bundle.version === "string" ? bundle.version : "",
          origin: origin,
          source: source,
          availability: typeof bundle.availability === "string" ? bundle.availability : "",
          installed: bundle.installed === true,
          enabled: bundle.enabled === true,
          removable: bundle.removable === true,
          optional: bundle.optional === true,
          readOnlyReason: typeof bundle.readOnlyReason === "string" ? bundle.readOnlyReason : "",
          rowCount: rows.length,
          disabledRows: rows.filter((row) => row !== null && typeof row === "object" && row.enabled === false).length,
          overrideCount: overrides.length,
          meta: bundle.meta === undefined || bundle.meta === null ? undefined : bundle.meta,
          error: bundle.error === undefined || bundle.error === null ? undefined : bundle.error,
        };
      });
    }

    /** One bundle as a plain-language card: what it is, where from, what it touches, how to undo. */
    function PluginGuideCard(props) {
      const t = props.t;
      const row = props.row;
      const resolveText = props.resolveText;
      const rawTitle = row.meta === undefined ? undefined : resolveText(row.meta.title);
      const title = typeof rawTitle === "string" && rawTitle !== "" ? rawTitle : row.name;
      const description = row.meta === undefined ? undefined : resolveText(row.meta.description);
      const facts = [t(row.origin)];
      if (row.version !== "") facts.push("v" + row.version);
      facts.push(row.enabled ? t("gEnabled") : t("gDisabled"));
      facts.push(t("gRows", { count: row.rowCount }));
      if (row.overrideCount > 0) facts.push(t("gOverrides", { count: row.overrideCount }));
      const toggleable = row.installed && row.readOnlyReason === "" && (row.optional || row.removable);
      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
            border: "0.5px solid var(--dsw-alias-border-l3)",
            borderRadius: 8,
            background: "var(--dsw-alias-bg-layer-1)",
            padding: "10px 12px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 } },
          h("span", { style: { color: PRIMARY, fontWeight: 500, flex: "none" } }, title),
          h(
            "span",
            {
              title: row.source === "" ? row.name : row.source,
              style: {
                color: MUTED,
                fontSize: 11,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            row.source === "" ? row.name : row.source,
          ),
        ),
        typeof description === "string" && description !== ""
          ? h("div", { style: { color: SECONDARY } }, description)
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 6, flexWrap: "wrap", color: MUTED, fontSize: 11 } },
          facts.map((fact, index) => h("span", { key: index }, fact)),
        ),
        row.name === ID ? h(FeatureSwitches, { key: "features", t: t, view: "page" }) : null,
        h("div", { style: { color: MUTED, fontSize: 11 } }, t("gRevertHint")),
        toggleable
          ? h(
              "button",
              {
                type: "button",
                disabled: props.pending === true,
                onClick: () => props.onToggle(row.name, !row.enabled),
                style: {
                  alignSelf: "flex-start",
                  padding: "2px 10px",
                  border: "0.5px solid var(--dsw-alias-border-l3)",
                  borderRadius: 999,
                  background: "transparent",
                  color: SECONDARY,
                  font: "inherit",
                  fontSize: 11.5,
                  lineHeight: 1.8,
                  cursor: props.pending === true ? "default" : "pointer",
                },
              },
              row.enabled ? t("gToggleOff") : t("gToggleOn"),
            )
          : row.readOnlyReason === ""
            ? null
            : h("div", { style: { color: MUTED, fontSize: 11 } }, t("gLocked", { reason: row.readOnlyReason })),
      );
    }

    /** The plain list itself; the page above owns loading and toggling. */
    function PluginGuideList(props) {
      const t = props.t;
      const rows = Array.isArray(props.rows) ? props.rows : [];
      if (rows.length === 0) return h("div", { style: { color: MUTED } }, t("gEmpty"));
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        rows.map((row) =>
          h(PluginGuideCard, {
            key: row.id,
            row: row,
            t: t,
            resolveText: props.resolveText,
            onToggle: props.onToggle,
            pending: props.pendingId === row.id,
          }),
        ),
      );
    }

    /**
     * The plain-language page that stands in the official Plugins tab.
     *
     * It reads the bundle list through the plugin-manager remote supplied by the
     * registration's `inject`, and narrates each bundle: what it is, where it came
     * from, which rows it contributes, and how to undo it.
     */
    function PluginGuideTab(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const fetchBundles = props ? props.fetchBundles : undefined;
      const setBundleEnabled = props ? props.setBundleEnabled : undefined;
      const resolveText =
        props && typeof props.resolveText === "function"
          ? props.resolveText
          : (value) => (typeof value === "string" ? value : undefined);
      const [state, setState] = useState({ phase: "idle", rows: [], error: undefined });
      const [pendingId, setPendingId] = useState(undefined);

      useEffect(() => {
        if (typeof fetchBundles !== "function") {
          setState({ phase: "unavailable", rows: [], error: undefined });
          return undefined;
        }
        let alive = true;
        setState({ phase: "loading", rows: [], error: undefined });
        Promise.resolve(fetchBundles())
          .then((result) => {
            if (!alive) return;
            if (result === null || result === undefined || result.ok !== true) {
              const error = result === null || result === undefined ? undefined : result.error;
              setState({
                phase: "error",
                rows: [],
                error: error === undefined || error === null ? "" : String(error.code === undefined ? error : error.code),
              });
              return;
            }
            const value = result.value === undefined || result.value === null ? result : result.value;
            const bundles = Array.isArray(value) ? value : value.bundles;
            setState({ phase: "ready", rows: pluginGuideRows(bundles), error: undefined });
          })
          .catch((error) => {
            if (!alive) return;
            setState({ phase: "error", rows: [], error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
          });
        return () => {
          alive = false;
        };
      }, [fetchBundles]);

      const toggle = (name, enabled) => {
        if (typeof setBundleEnabled !== "function") return;
        setPendingId(name);
        Promise.resolve(setBundleEnabled(name, enabled))
          .catch(() => undefined)
          .then(() => {
            setPendingId(undefined);
            if (typeof fetchBundles === "function") {
              return Promise.resolve(fetchBundles()).then((result) => {
                if (result === null || result === undefined || result.ok !== true) return;
                const value = result.value === undefined || result.value === null ? result : result.value;
                setState({ phase: "ready", rows: pluginGuideRows(Array.isArray(value) ? value : value.bundles), error: undefined });
                return undefined;
              });
            }
            return undefined;
          })
          .catch(() => undefined);
      };

      const body = [];
      if (state.phase === "unavailable") body.push(h("div", { key: "note", style: { color: SECONDARY } }, t("gUnavailable")));
      else if (state.phase === "error") {
        body.push(h("div", { key: "note", style: { color: "var(--dsw-alias-state-error-primary, #d9534f)" } }, t("gError", { code: state.error === "" ? "?" : state.error })));
      } else if (state.phase === "idle" || state.phase === "loading") {
        body.push(h("div", { key: "note", style: { color: MUTED } }, t("gLoading")));
      } else {
        body.push(
          h(PluginGuideList, {
            key: "list",
            rows: state.rows,
            t: t,
            resolveText: resolveText,
            onToggle: toggle,
            pendingId: pendingId,
          }),
        );
      }

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "4px 2px",
            color: PRIMARY,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        h("div", { style: { fontSize: 14, fontWeight: 500, color: PRIMARY } }, t("pluginsGuideTitle")),
        body,
      );
    }

    /* ------------------------------------------------------------------ *
     * FZL toolkit: the settings section that groups this package's
     * sub-features, and the Session manager its first new feature adds.
     * ------------------------------------------------------------------ */

    const TOOLKIT_LIST_ROUTE = "/fzl-toolkit/sessions";
    const TOOLKIT_DELETE_ROUTE = "/fzl-toolkit/sessions/delete";

    /**
     * Call one toolkit route.
     *
     * A non-JSON answer means the Host half is not mounted in this process (the
     * route falls through to the SPA page), which the panel reports as
     * "restart DSH" instead of as a parse failure.
     */
    function toolkitRequest(url, body) {
      const headers = { "x-fzl-toolkit": "1" };
      const init = { headers: headers, cache: "no-store" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.method = "POST";
        init.body = JSON.stringify(body);
      }
      return fetch(url, init).then((response) =>
        response
          .json()
          .then((payload) => ({ status: response.status, payload: payload }))
          .catch(() => ({ status: response.status, payload: undefined })),
      );
    }

    /** Byte counts in the unit style of a storage list. */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
      if (bytes < 1024) return Math.round(bytes) + " B";
      const units = ["KB", "MB", "GB", "TB"];
      let value = bytes / 1024;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return value.toFixed(value < 10 ? 1 : 0) + " " + units[index];
    }

    /** Epoch-ms as a local `YYYY-MM-DD HH:mm`. */
    function formatWhen(timestamp) {
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "";
      const date = new Date(timestamp);
      const two = (part) => String(part).padStart(2, "0");
      return (
        date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate()) +
        " " + two(date.getHours()) + ":" + two(date.getMinutes())
      );
    }

    /**
     * One switchable feature card inside the toolkit page.
     *
     * The card carries the feature's promise and its own switch: turning it off
     * withdraws exactly that feature's UI until it is turned back on.
     */
    function FeatureCard(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const enabled = props.enabled !== false;
      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 3,
            padding: "9px 11px",
            border: "0.5px solid var(--dsw-alias-border-l3)",
            borderRadius: 8,
            background: "var(--dsw-alias-bg-layer-1, transparent)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 } },
          h("span", { style: { fontSize: 13, fontWeight: 500, color: PRIMARY } }, props.title),
          h("span", { style: { fontSize: 11.5, color: MUTED, whiteSpace: "nowrap" } }, t(enabled ? "featureOn" : "featureOff")),
        ),
        h("div", { style: { fontSize: 12, lineHeight: 1.6, color: SECONDARY } }, props.hint),
        h(
          "div",
          { style: { display: "flex", justifyContent: "flex-end", paddingTop: 2 } },
          h(ToolkitButton, {
            label: t(enabled ? "featureDisable" : "featureEnable"),
            onClick: () => props.onToggle(!enabled),
          }),
        ),
      );
    }

    /**
     * The three feature switches.
     *
     * The canonical home is this bundle's own page in the Plugins list
     * (`plugins.bundle.config`, keyed by package name); the plain view renders the
     * same component inside its card, so both views expose the same switches.
     */
    function FeatureSwitches(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const view = props === undefined || props.view === undefined ? "page" : props.view;
      const flags = useFeatures();
      const shipped = primitives();
      const ShippedSwitch = shipped !== null && typeof shipped.Switch === "function" ? shipped.Switch : undefined;
      const rows = [
        { key: "execLog", title: t("feature.execLog"), hint: t("feature.execLogHint") },
        { key: "sessionDelete", title: t("feature.sessionDelete"), hint: t("feature.sessionDeleteHint") },
      ];
      const enabledCount = rows.filter((row) => flags[row.key] !== false).length;
      const summary = t("featureSummary", { on: enabledCount, total: rows.length });
      if (view === "summary") {
        return h("span", { style: { fontSize: 11.5, color: MUTED } }, summary);
      }
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, padding: "2px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 } },
          h("div", { style: { fontSize: 13, fontWeight: 500, color: PRIMARY } }, t("featuresTitle")),
          h("span", { style: { fontSize: 11.5, color: MUTED } }, summary),
        ),
        rows.map((row) => {
          const enabled = flags[row.key] !== false;
          return h(
            "div",
            {
              key: row.key,
              style: {
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                border: "0.5px solid var(--dsw-alias-border-l3)",
                borderRadius: 8,
              },
            },
            h(
              "div",
              { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: 12.5, color: PRIMARY } }, row.title),
              h("div", { style: { fontSize: 11, color: MUTED } }, row.hint),
            ),
            ShippedSwitch === undefined
              ? h(ToolkitButton, {
                  label: t(enabled ? "featureDisable" : "featureEnable"),
                  onClick: () => featureFlags.set(row.key, !enabled),
                })
              : h(ShippedSwitch, {
                  checked: enabled,
                  label: t("featureToggle", { name: row.title }),
                  onChange: (next) => featureFlags.set(row.key, next === true),
                }),
          );
        }),
      );
    }

    /** Small neutral button that follows the host's control metrics. */
    function ToolkitButton(props) {
      return h(
        "button",
        {
          type: "button",
          disabled: props.disabled === true,
          onClick: props.onClick,
          style: {
            padding: "3px 10px",
            border: "0.5px solid " + (props.danger === true ? "var(--dsw-alias-state-error-primary, #d9534f)" : "var(--dsw-alias-border-l3)"),
            borderRadius: 6,
            background: "transparent",
            color: props.danger === true ? "var(--dsw-alias-state-error-primary, #d9534f)" : PRIMARY,
            font: "inherit",
            fontSize: 12,
            lineHeight: 1.7,
            cursor: props.disabled === true ? "default" : "pointer",
            opacity: props.disabled === true ? 0.55 : 1,
            whiteSpace: "nowrap",
          },
        },
        props.label,
      );
    }

    /** Shared metrics for one row of the Session "..." menu. */
    const MENU_ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      width: "100%",
      padding: "6px 10px",
      border: "none",
      borderRadius: 6,
      background: "transparent",
      font: "inherit",
      fontSize: 12.5,
      lineHeight: 1.7,
      textAlign: "left",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    /**
     * One row in a Session's "..." menu: delete that Session.
     *
     * The sidebar owns the menu's open state, so the row dismisses it through the
     * injected `useMenuOpenState` hook once the request settles. That hook's exact
     * shape belongs to the sidebar, so a callable and a `{ close }` object are
     * both accepted.
     */
    function SessionDeleteMenuItem(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const sessionId = props ? props.sessionId : undefined;
      const [phase, setPhase] = useState("idle");
      const [error, setError] = useState("");
      const menuState = props && typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : undefined;

      const dismissMenu = () => {
        try {
          if (typeof menuState === "function") menuState();
          else if (menuState !== null && menuState !== undefined && typeof menuState.close === "function") menuState.close();
        } catch (failure) {
          // A menu that already closed is not a failure.
        }
      };

      const remove = () => {
        if (typeof sessionId !== "string" || sessionId === "") return;
        setPhase("busy");
        setError("");
        toolkitRequest(TOOLKIT_DELETE_ROUTE, { sessionId: sessionId })
          .then((answer) => {
            const payload = answer.payload;
            if (payload !== undefined && payload.ok === true) {
              dismissMenu();
              window.location.reload();
              return;
            }
            const code = payload === undefined ? "host-unavailable" : String(payload.error === undefined ? "?" : payload.error);
            setPhase("error");
            setError(code === "session-busy" ? t("sessionBusy") : code);
          })
          .catch(() => {
            setPhase("error");
            setError("network");
          });
      };

      const label = phase === "busy" ? t("menuDeleteBusy") : phase === "confirm" ? t("menuConfirmDelete") : t("menuDelete");

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2 } },
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            disabled: phase === "busy",
            onClick: () => {
              if (phase === "confirm") remove();
              else setPhase("confirm");
            },
            style: {
              ...MENU_ROW_STYLE,
              color: "var(--dsw-alias-state-error-primary, #d9534f)",
              opacity: phase === "busy" ? 0.55 : 1,
            },
          },
          label,
        ),
        error === ""
          ? null
          : h(
              "div",
              {
                style: {
                  padding: "0 10px 4px",
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "normal",
                  color: "var(--dsw-alias-state-error-primary, #d9534f)",
                },
              },
              error,
            ),
      );
    }

    /** The toolkit settings page: the feature switches plus the Session manager. */
    function ToolkitSection(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const flags = useFeatures();
      const [state, setState] = useState({ phase: "loading", rows: [], home: "", error: "" });
      const [pending, setPending] = useState("");
      const [asking, setAsking] = useState("");
      const [notice, setNotice] = useState(null);

      const load = () => {
        setState((current) => ({ ...current, phase: "loading", error: "" }));
        toolkitRequest(TOOLKIT_LIST_ROUTE)
          .then((answer) => {
            const payload = answer.payload;
            if (payload === undefined) {
              setState({ phase: "unavailable", rows: [], home: "", error: "" });
              return;
            }
            if (payload.ok !== true) {
              setState({
                phase: answer.status === 403 ? "forbidden" : "error",
                rows: [],
                home: "",
                error: String(payload.error === undefined ? "?" : payload.error),
              });
              return;
            }
            setState({
              phase: "ready",
              rows: Array.isArray(payload.sessions) ? payload.sessions : [],
              home: typeof payload.home === "string" ? payload.home : "",
              error: "",
            });
          })
          .catch(() => setState({ phase: "error", rows: [], home: "", error: "network" }));
      };

      useEffect(() => {
        load();
      }, []);

      const remove = (row) => {
        setPending(row.sessionId);
        setAsking("");
        setNotice(null);
        toolkitRequest(TOOLKIT_DELETE_ROUTE, { sessionId: row.sessionId })
          .then((answer) => {
            setPending("");
            const payload = answer.payload;
            if (payload === undefined || payload.ok !== true) {
              const code = payload === undefined ? "host-unavailable" : String(payload.error === undefined ? "?" : payload.error);
              setNotice({
                kind: "error",
                text: t("sessionFailed", { reason: code === "session-busy" ? t("sessionBusy") : code }),
              });
              return;
            }
            setNotice({
              kind: "ok",
              text:
                t("sessionDeletedOne", { title: row.title || t("sessionUntitled"), size: formatBytes(payload.freedBytes) }) +
                " " + t("sessionReloadHint"),
            });
            load();
          })
          .catch(() => {
            setPending("");
            setNotice({ kind: "error", text: t("sessionFailed", { reason: "network" }) });
          });
      };

      const totalBytes = state.rows.reduce((sum, row) => sum + (typeof row.bytes === "number" ? row.bytes : 0), 0);

      const sessionBody = [];
      if (flags.sessionDelete === false) {
        sessionBody.push(h("div", { key: "off", style: { fontSize: 12, color: MUTED } }, t("featureOffHint")));
      } else if (state.phase === "unavailable" || state.phase === "forbidden") {
        sessionBody.push(
          h("div", { key: "note", style: { fontSize: 12, color: MUTED } }, t(state.phase === "forbidden" ? "sessionsForbidden" : "sessionsUnavailable")),
        );
      } else if (state.phase === "error") {
        sessionBody.push(
          h("div", { key: "note", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d9534f)" } }, t("sessionsFailed", { reason: state.error })),
        );
      } else if (state.phase === "loading" && state.rows.length === 0) {
        sessionBody.push(h("div", { key: "note", style: { fontSize: 12, color: MUTED } }, t("sessionsLoading")));
      } else if (state.rows.length === 0) {
        sessionBody.push(h("div", { key: "note", style: { fontSize: 12, color: MUTED } }, t("sessionsEmpty")));
      } else {
        sessionBody.push(
          h(
            "div",
            { key: "list", style: { display: "flex", flexDirection: "column", gap: 6 } },
            state.rows.map((row) => {
              const meta = [
                formatWhen(row.updatedAt),
                formatBytes(row.bytes),
                row.workspacePath || row.cwd,
                row.live === true ? t("sessionLive") : "",
                row.archived === true ? t("sessionArchived") : "",
              ]
                .filter((part) => typeof part === "string" && part !== "")
                .join(" · ");
              const confirming = asking === row.sessionId;
              const busy = pending === row.sessionId;
              return h(
                "div",
                {
                  key: row.sessionId,
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    border: "0.5px solid var(--dsw-alias-border-l3)",
                    borderRadius: 8,
                  },
                },
                h(
                  "div",
                  { style: { flex: 1, minWidth: 0 } },
                  h(
                    "div",
                    {
                      style: {
                        fontSize: 12.5,
                        color: PRIMARY,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    },
                    row.title || t("sessionUntitled"),
                  ),
                  h(
                    "div",
                    {
                      style: {
                        fontSize: 11,
                        color: MUTED,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    },
                    meta,
                  ),
                ),
                confirming
                  ? h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 } },
                      h("span", { style: { fontSize: 11.5, color: SECONDARY } }, t("sessionConfirm", { title: row.title || t("sessionUntitled") })),
                      h(ToolkitButton, { label: t("sessionCancel"), onClick: () => setAsking("") }),
                      h(ToolkitButton, {
                        label: t("sessionConfirmYes"),
                        danger: true,
                        disabled: busy,
                        onClick: () => remove(row),
                      }),
                    )
                  : h(ToolkitButton, {
                      label: busy ? t("sessionDeleting") : t("sessionDelete"),
                      danger: true,
                      disabled: busy,
                      onClick: () => setAsking(row.sessionId),
                    }),
              );
            }),
          ),
        );
      }

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "4px 2px",
            color: PRIMARY,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2 } },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
            h("div", { style: { fontSize: 14, fontWeight: 500, color: PRIMARY } }, t("toolkitTitle")),
            h("button", {
              type: "button",
              onClick: () => window.location.reload(),
              style: { padding: "1px 8px", border: "0.5px solid " + BORDER, borderRadius: 5, background: "transparent", color: SECONDARY, font: "inherit", fontSize: 10, cursor: "pointer" },
            }, t("traceReload")),
          ),
          h("div", { style: { fontSize: 12, color: SECONDARY } }, t("toolkitDescription")),
        ),
        h("div", { style: { fontSize: 11.5, color: MUTED } }, t("featuresMovedHint")),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 } },
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 2 } },
              h("div", { style: { fontSize: 13, fontWeight: 500, color: PRIMARY } }, t("sessionsTitle")),
              h("div", { style: { fontSize: 11.5, color: MUTED } }, t("sessionsHint")),
            ),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } },
              state.phase === "ready"
                ? h("span", { style: { fontSize: 11.5, color: MUTED } }, t("sessionsMeta", { count: state.rows.length, size: formatBytes(totalBytes) }))
                : null,
              h(ToolkitButton, { label: t("sessionsRefresh"), onClick: load }),
            ),
          ),
          notice === null
            ? null
            : h(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: notice.kind === "ok" ? SECONDARY : "var(--dsw-alias-state-error-primary, #d9534f)",
                  },
                },
                h("span", null, notice.text),
                notice.kind === "ok"
                  ? h(ToolkitButton, { label: t("reloadPage"), onClick: () => window.location.reload() })
                  : null,
              ),
          sessionBody,
          state.home === ""
            ? null
            : h("div", { style: { fontSize: 11, color: MUTED } }, state.home),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * About DSH: the installation itself, as one settings page.
     *
     * Two panes, two sources. The disk pane reads the Host's `/fzl-toolkit/
     * layout` route one level at a time, so a huge tree costs nothing until
     * a directory is opened. The plugin pane reads the same Remote faces the
     * official Plugins page uses, so it shows what this profile actually
     * composed instead of a hard-coded list.
     * ------------------------------------------------------------------ */

    const ABOUT_ROUTE = "/fzl-toolkit/layout";

    /** The client locale face, captured at apply time, for plugin metadata text. */
    let aboutLocale;

    /** Resolve one metadata value - a string or a locale map - to the active text. */
    function metaText(value) {
      if (typeof value === "string") return value;
      if (value === null || value === undefined) return "";
      try {
        if (aboutLocale !== undefined && aboutLocale !== null && typeof aboutLocale.resolveText === "function") {
          const resolved = aboutLocale.resolveText(value);
          if (typeof resolved === "string") return resolved;
        }
      } catch (error) {
        // A metadata value the locale cannot resolve stays silent.
      }
      return "";
    }

    /** The display name and one-line description of one plugin package. */
    function metaFacts(meta) {
      if (meta === null || meta === undefined || typeof meta !== "object") return { title: "", description: "" };
      return { title: metaText(meta.title), description: metaText(meta.description) };
    }

    /**
     * The client Remote face, captured at apply time.
     *
     * The Settings owner is not guaranteed to resolve an `inject` face for a
     * section, so the plugin pane reads the same Remote namespaces from here
     * when the registration's props arrive empty.
     */
    let aboutRemote;

    /**
     * One Remote namespace, or `undefined`.
     *
     * A namespace this plug-in may not call answers with a thrown error on
     * access rather than `undefined`, and that access happens while Settings
     * renders - one throw there blanks the whole panel. So every access is
     * guarded, and a missing face degrades that pane only.
     */
    function remoteNamespace(name) {
      try {
        const remote = aboutRemote;
        if (remote === undefined || remote === null) return undefined;
        return remote[name];
      } catch (error) {
        return undefined;
      }
    }

    function remoteBundles() {
      try {
        const manager = remoteNamespace("pluginManager");
        if (manager === undefined || manager === null || typeof manager.listBundles !== "function") return undefined;
        return manager.listBundles();
      } catch (error) {
        return undefined;
      }
    }

    function remoteInventory() {
      try {
        const inventory = remoteNamespace("pluginInventory");
        if (inventory === undefined || inventory === null || typeof inventory.list !== "function") return undefined;
        return inventory.list();
      } catch (error) {
        return undefined;
      }
    }

    /** The layout route with an optional level and refresh flag. */
    function layoutUrl(path, refresh) {
      const parts = [];
      if (typeof path === "string" && path !== "") parts.push("path=" + encodeURIComponent(path));
      if (refresh === true) parts.push("refresh=1");
      return parts.length === 0 ? ABOUT_ROUTE : ABOUT_ROUTE + "?" + parts.join("&");
    }

    /** One layout request; `path` absent asks for the overview. */
    function layoutRequest(path, refresh) {
      return toolkitRequest(layoutUrl(path, refresh));
    }

    /**
     * Join the live loader entries with the profile's bundles.
     *
     * A bundle's rows name the module each patch inserts; the inventory names
     * what the Loader actually holds, by entry id and module name. Matching on
     * the entry id first keeps two rows of one module distinct; the module name
     * is the fallback for a row the Loader no longer lists.
     */
    function pluginGraph(bundles, inventory) {
      const entries = inventory !== null && typeof inventory === "object" && Array.isArray(inventory.entries) ? inventory.entries : [];
      const byEntryId = new Map();
      const byModule = new Map();
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        if (typeof entry.entryId === "string") byEntryId.set(entry.entryId, entry);
        const module = typeof entry.moduleName === "string" ? entry.moduleName : "";
        if (module === "") continue;
        if (!byModule.has(module)) byModule.set(module, []);
        byModule.get(module).push(entry);
      }
      const resolve = (row) => {
        if (typeof row.entryId === "string" && byEntryId.has(row.entryId)) return byEntryId.get(row.entryId);
        if (typeof row.moduleName === "string" && byModule.has(row.moduleName)) return byModule.get(row.moduleName)[0];
        return undefined;
      };
      const groups = (Array.isArray(bundles) ? bundles : []).map((bundle) => {
        const bundleRows = bundle !== null && typeof bundle === "object" && Array.isArray(bundle.rows) ? bundle.rows : [];
        const rows = bundleRows.map((row, index) => {
          const live = row !== null && typeof row === "object" ? resolve(row) : undefined;
          return {
            key: String(
              row !== null && typeof row === "object"
                ? row.rowId || row.entryId || row.moduleName || "row-" + index
                : "row-" + index,
            ),
            moduleName: row !== null && typeof row === "object" && typeof row.moduleName === "string" ? row.moduleName : "",
            entryId: row !== null && typeof row === "object" && typeof row.entryId === "string" ? row.entryId : "",
            live: live !== undefined,
            enabled: live === undefined ? true : live.enabled !== false,
            fiberPhase:
              live !== undefined && live.fiberPhase !== null && live.fiberPhase !== undefined ? String(live.fiberPhase) : "",
            meta: row !== null && typeof row === "object" && row.meta !== null && typeof row.meta === "object" ? row.meta : undefined,
          };
        });
        return {
          name: bundle !== null && typeof bundle === "object" && typeof bundle.name === "string" ? bundle.name : "",
          version: bundle !== null && typeof bundle === "object" && typeof bundle.version === "string" ? bundle.version : "",
          source: bundle !== null && typeof bundle === "object" && typeof bundle.source === "string" ? bundle.source : "",
          enabled: bundle !== null && typeof bundle === "object" && bundle.enabled === true,
          meta: bundle !== null && typeof bundle === "object" && bundle.meta !== null && typeof bundle.meta === "object" ? bundle.meta : undefined,
          availability:
            bundle !== null && typeof bundle === "object" && typeof bundle.availability === "string"
              ? bundle.availability
              : "",
          error: bundle !== null && typeof bundle === "object" && bundle.error !== undefined && bundle.error !== null
            ? String(bundle.error.code === undefined ? bundle.error : bundle.error.code)
            : "",
          rows: rows,
          disabled: rows.filter((row) => row.enabled === false).length,
        };
      });
      const presets =
        inventory !== null && typeof inventory === "object"
          ? Array.isArray(inventory.agentPresets)
            ? inventory.agentPresets
            : Array.isArray(inventory.presets)
              ? inventory.presets
              : []
          : [];
      return { groups, presets, entries };
    }

    /** One status dot: the only colour this page spends on state. */
    function aboutDot(tone) {
      const color =
        tone === "on"
          ? "var(--dsw-alias-state-success-primary, #2f9e5f)"
          : tone === "warn"
            ? "var(--dsw-alias-state-warn-primary, #c98a00)"
            : "var(--dsw-alias-state-idle-primary, #b6b9c0)";
      return h("span", { style: { width: 6, height: 6, borderRadius: 3, background: color, flex: "none" } });
    }

    /**
     * About DSH: what this installation is made of.
     *
     * The framework pane is a fixed set of named places - launcher, app,
     * runtime, data home, profile, session log, workspace - each with the
     * job it does, not a listing of every file. Sizes appear where they are
     * cheap; a cut-off scan prints `>=`.
     */
    function AboutBody(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const [state, setState] = useState({ phase: "loading", data: undefined, error: "" });
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [openBundles, setOpenBundles] = useState(() => new Set());

      const load = (refresh) => {
        setState((current) => ({ ...current, phase: "loading", error: "" }));
        layoutRequest(undefined, refresh)
          .then((answer) => {
            const payload = answer.payload;
            if (payload === undefined) {
              setState({ phase: "unavailable", data: undefined, error: "" });
              return;
            }
            if (payload.ok !== true) {
              setState({
                phase: answer.status === 403 ? "forbidden" : "error",
                data: undefined,
                error: String(payload.error === undefined ? "?" : payload.error),
              });
              return;
            }
            setState({ phase: "ready", data: payload, error: "" });
          })
          .catch(() => setState({ phase: "error", data: undefined, error: "network" }));
      };

      useEffect(() => {
        load(false);
      }, []);

      const data = state.data;
      const rows = data !== undefined && Array.isArray(data.rows) ? data.rows : [];
      const plugins = data !== undefined && data.plugins !== null && typeof data.plugins === "object" ? data.plugins : undefined;
      const graph = pluginGraph(plugins === undefined ? undefined : plugins.bundles, plugins === undefined ? undefined : plugins.inventory);
      const composition = data !== undefined && data.composition !== null && typeof data.composition === "object" ? data.composition : undefined;

      const rowByKey = new Map(rows.map((row) => [String(row.key), row]));
      const parents = new Set(rows.map((row) => String(row.parent === undefined ? "" : row.parent)).filter((key) => key !== ""));
      const visibleRows = rows.filter((row) => {
        let parent = String(row.parent === undefined ? "" : row.parent);
        while (parent !== "") {
          if (collapsed.has(parent)) return false;
          const up = rowByKey.get(parent);
          parent = up === undefined ? "" : String(up.parent === undefined ? "" : up.parent);
        }
        return true;
      });
      const toggleCollapsed = (key) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      const toggleBundle = (name) => {
        setOpenBundles((current) => {
          const next = new Set(current);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
      };


      const fact = (label, value, title) =>
        value === "" || value === undefined
          ? null
          : h(
              "div",
              { key: "fact-" + label, style: { display: "flex", gap: 8, minWidth: 0, fontSize: 12 } },
              h("span", { style: { flex: "none", width: 62, color: MUTED } }, label),
              h(
                "span",
                {
                  title: title === undefined ? value : title,
                  style: {
                    minWidth: 0,
                    color: SECONDARY,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "Consolas, monospace",
                    fontSize: 11.5,
                  },
                },
                value,
              ),
            );

      const frameworkRow = (row) => {
        const key = String(row.key);
        const parts = String(row.path === undefined ? "" : row.path).split(/[\\/]/).filter((part) => part !== "");
        const name = parts.length === 0 ? String(row.path) : parts[parts.length - 1];
        const hasChildren = parents.has(key);
        const open = !collapsed.has(key);
        const metric =
          typeof row.bytes === "number"
            ? (row.truncated === true ? t("aboutTruncated") + " " : "") + formatBytes(row.bytes)
            : row.kind === "dir"
              ? t("aboutItems", { count: row.children === undefined ? 0 : row.children })
              : "";
        return h(
          "div",
          {
            key: key,
            onClick: hasChildren ? () => toggleCollapsed(key) : undefined,
            title: hasChildren ? t("aboutToggle") : row.path,
            style: {
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              minWidth: 0,
              marginLeft: 2,
              paddingLeft: (typeof row.depth === "number" ? row.depth : 0) * 14,
              paddingTop: 2,
              paddingBottom: 2,
              borderRadius: 4,
              cursor: hasChildren ? "pointer" : "default",
              borderLeft: (typeof row.depth === "number" ? row.depth : 0) > 0 ? "1px solid " + BORDER : "none",
            },
          },
          h(
            "span",
            { style: { flex: "none", fontSize: 9, color: MUTED, width: 8, textAlign: "center" } },
            hasChildren ? (open ? "\u25be" : "\u25b8") : row.kind === "dir" ? "\u00b7" : "\u00b7",
          ),
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h(
              "div",
              {
                style: {
                  fontSize: 12,
                  color: PRIMARY,
                  fontFamily: "Consolas, monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              name,
            ),
            h(
              "div",
              { style: { fontSize: 10.5, color: MUTED, lineHeight: 1.5 } },
              t("aboutRole_" + String(row.role === undefined ? "" : row.role)),
            ),
          ),
          metric === "" ? null : h("span", { style: { flex: "none", fontSize: 10.5, color: MUTED } }, metric),
        );
      };

      const compositionBody =
        composition === undefined
          ? null
          : h(
              "div",
              {
                key: "composition",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: "0.5px solid " + BORDER,
                },
              },
              h(
                "div",
                { style: { fontSize: 10.5, color: MUTED } },
                t("aboutComposition", {
                  bundles: Array.isArray(composition.bundles) ? composition.bundles.length : 0,
                  patches: Array.isArray(composition.patchIds) ? composition.patchIds.length : 0,
                }),
              ),
              (Array.isArray(composition.bundles) ? composition.bundles : []).map((name) =>
                h(
                  "div",
                  {
                    key: "bundle-" + name,
                    title: name,
                    style: {
                      paddingLeft: 12,
                      fontSize: 11,
                      color: SECONDARY,
                      fontFamily: "Consolas, monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  name,
                ),
              ),
            );

      const frameworkBody =
        state.phase === "unavailable"
          ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutHostDown"))
          : state.phase === "forbidden"
            ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutHostForbidden"))
            : state.phase === "error"
              ? h(
                  "div",
                  { style: { fontSize: 11.5, color: "var(--dsw-alias-state-error-primary, #d9534f)" } },
                  t("aboutHostFailed", { reason: state.error }),
                )
              : state.phase === "loading" && data === undefined
                ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutScanning"))
                : h("div", { style: { display: "flex", flexDirection: "column" } }, visibleRows.map(frameworkRow), compositionBody);

      const pluginError =
        plugins !== undefined && typeof plugins.error === "string" && plugins.error !== ""
          ? h("div", { style: { fontSize: 10.5, color: MUTED } }, t("aboutPluginError", { reason: plugins.error }))
          : null;

      const pluginBody =
        state.phase === "unavailable"
          ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutHostDown"))
          : state.phase === "loading" && data === undefined
            ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutScanning"))
            : graph.groups.length === 0
              ? h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutInventoryDown"))
              : h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 8 } },
                  pluginError,
                  graph.groups.map((bundle) => {
                    const own = bundle.name === ID;
                    const info = metaFacts(bundle.meta);
                    const open = openBundles.has(bundle.name);
                    const facts = [t("aboutEntries", { count: bundle.rows.length })];
                    if (bundle.disabled > 0) facts.push(t("aboutDisabled", { count: bundle.disabled }));
                    if (bundle.error !== "") facts.push(bundle.error);
                    const description =
                      info.description !== "" ? info.description : bundle.source !== "" ? bundle.source : "";
                    return h(
                      "div",
                      {
                        key: "bundle-" + bundle.name,
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                          padding: "7px 9px",
                          border: "0.5px solid " + BORDER,
                          borderRadius: 7,
                        },
                      },
                      h(
                        "div",
                        {
                          onClick: () => toggleBundle(bundle.name),
                          title: t("aboutToggle"),
                          style: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, cursor: "pointer" },
                        },
                        h(
                          "span",
                          { style: { flex: "none", fontSize: 9, color: MUTED, width: 8, textAlign: "center" } },
                          open ? "\u25be" : "\u25b8",
                        ),
                        aboutDot(bundle.enabled ? "on" : "off"),
                        h(
                          "span",
                          {
                            style: {
                              flex: "none",
                              maxWidth: "55%",
                              fontSize: 12.5,
                              fontWeight: 500,
                              color: PRIMARY,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            },
                          },
                          own && info.title !== "" ? info.title + " / " + bundle.name : bundle.name,
                        ),
                        own
                          ? h(
                              "span",
                              {
                                style: {
                                  flex: "none",
                                  fontSize: 10,
                                  color: SECONDARY,
                                  border: "0.5px solid " + BORDER,
                                  borderRadius: 999,
                                  padding: "0 5px",
                                },
                              },
                              t("aboutOwnPackage"),
                            )
                          : null,
                        description === ""
                          ? null
                          : h(
                              "span",
                              {
                                title: description,
                                style: {
                                  flex: 1,
                                  minWidth: 0,
                                  fontSize: 10.5,
                                  color: MUTED,
                                  textAlign: "right",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                },
                              },
                              description,
                            ),
                        bundle.version === ""
                          ? null
                          : h("span", { style: { flex: "none", fontSize: 10.5, color: MUTED } }, "v" + bundle.version),
                      ),
                      h(
                        "div",
                        { style: { paddingLeft: 22, fontSize: 10.5, color: MUTED } },
                        facts.join(" \u00b7 "),
                      ),
                      open === false || bundle.rows.length === 0
                        ? null
                        : h(
                            "div",
                            { style: { display: "flex", flexDirection: "column", gap: 1, paddingTop: 1 } },
                            bundle.rows.map((row) => {
                              const rowInfo = metaFacts(row.meta);
                              return h(
                                "div",
                                {
                                  key: "row-" + bundle.name + "-" + row.key,
                                  title: rowInfo.description === "" ? row.entryId : rowInfo.description,
                                  style: { display: "flex", alignItems: "center", gap: 6, paddingLeft: 22, minHeight: 20 },
                                },
                                aboutDot(row.enabled === false ? "off" : row.fiberPhase === "" ? "warn" : "on"),
                                h(
                                  "span",
                                  {
                                    style: {
                                      minWidth: 0,
                                      fontSize: 11,
                                      color: row.enabled === false ? MUTED : SECONDARY,
                                      fontFamily: "Consolas, monospace",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    },
                                  },
                                  rowInfo.title !== "" ? rowInfo.title : row.moduleName,
                                ),
                                row.fiberPhase === ""
                                  ? null
                                  : h(
                                      "span",
                                      { style: { flex: "none", fontSize: 10, color: MUTED } },
                                      t("aboutFiber", { phase: row.fiberPhase }),
                                    ),
                              );
                            }),
                          ),
                    );
                  }),
                  graph.presets.length === 0
                    ? null
                    : h(
                        "div",
                        { style: { display: "flex", flexDirection: "column", gap: 2, paddingTop: 2 } },
                        h("div", { style: { fontSize: 11, color: MUTED } }, t("aboutAgentPresets")),
                        graph.presets.map((preset, index) => {
                          const count =
                            typeof preset.rows === "number"
                              ? preset.rows
                              : Array.isArray(preset.rows)
                                ? preset.rows.length
                                : 0;
                          const label = String(
                            preset.name === undefined ? (preset.id === undefined ? "?" : preset.id) : preset.name,
                          );
                          return h(
                            "div",
                            {
                              key: "preset-" + index,
                              style: { paddingLeft: 20, fontSize: 11.5, color: SECONDARY },
                            },
                            label + " \u00b7 " + t("aboutItems", { count: count }),
                          );
                        }),
                      ),
                );

      const pane = (key, title, hintText, actions, body) =>
        h(
          "div",
          {
            key: key,
            style: {
              flex: "1 1 320px",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "10px 12px",
              border: "0.5px solid " + BORDER,
              borderRadius: 8,
              background: DETAIL_BG,
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 } },
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
              h("div", { style: { fontSize: 13, fontWeight: 500, color: PRIMARY } }, title),
              h("div", { style: { fontSize: 11, color: MUTED } }, hintText),
            ),
            actions,
          ),
          h("div", { style: { minHeight: 0, maxHeight: "60vh", overflow: "auto" } }, body),
        );

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "4px 2px",
            maxWidth: 760,
            color: PRIMARY,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 } },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
            h("div", { style: { fontSize: 15, fontWeight: 600, color: PRIMARY } }, t("aboutTitle")),
            h("div", { style: { fontSize: 11.5, color: MUTED } }, t("aboutDescription")),
          ),
          h(ToolkitButton, {
            label: t("aboutRefresh"),
            disabled: state.phase === "loading",
            onClick: () => load(true),
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 1 } },
          fact(t("aboutVersion"), data === undefined ? "" : String(data.version === undefined ? "" : data.version)),
          fact(t("aboutProfile"), data === undefined ? "" : String(data.profile === undefined ? "" : data.profile)),
          fact(t("aboutRoot"), data === undefined ? "" : String(data.root === undefined ? "" : data.root)),
          fact(t("aboutHome"), data === undefined ? "" : String(data.home === undefined ? "" : data.home)),
        ),
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" } },
          pane("framework", t("aboutFramework"), t("aboutFrameworkHint"), null, frameworkBody),
          pane(
            "plugins",
            t("aboutPluginsTitle"),
            t("aboutPluginsHint"),
            graph.groups.length === 0
              ? null
              : h("span", { style: { fontSize: 10.5, color: MUTED, flex: "none" } }, t("aboutEntries", { count: graph.groups.length })),
            pluginBody,
          ),
        ),
      );
    }

    /**
     * Keeps a render failure inside this page.
     *
     * A section that throws is unmounted by React, leaving the Settings content
     * column blank with no clue why. This boundary turns that into one line
     * naming the error, which is the difference between a bug report and a
     * white page.
     */
    class AboutBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: "" };
      }

      static getDerivedStateFromError(error) {
        return {
          error: String(
            error !== null && error !== undefined && error.message !== undefined ? error.message : error,
          ),
        };
      }

      render() {
        const t = this.props !== null && this.props !== undefined && typeof this.props.t === "function" ? this.props.t : (key) => key;
        if (this.state.error !== "") {
          return h(
            "div",
            {
              style: {
                padding: "12px 2px",
                fontSize: 12,
                lineHeight: 1.7,
                color: "var(--dsw-alias-state-error-primary, #d9534f)",
              },
            },
            t("aboutRenderFailed", { reason: this.state.error }),
          );
        }
        return this.props.children;
      }
    }

    /** The Settings seat: the boundary in front, the page behind it. */
    function AboutSection(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      return h(AboutBoundary, { t: t }, h(AboutBody, props));
    }

    /** Panel body: the seat reports `sidebar`, `panel` and `tab` through `useTabInfo`. */

    /**
     * Chat-side entry: one action on a finalized assistant message that opens this
     * panel focused on that message's tool calls.
     */
    function ChatAction(props) {
      const t = props && typeof props.t === "function" ? props.t : (key) => key;
      const openPanel = props ? props.openPanel : undefined;
      const messageId = props ? props.messageId : undefined;
      const activate = typeof openPanel === "function" && typeof messageId === "string" ? () => openPanel(messageId) : undefined;
      return h(
        "button",
        {
          type: "button",
          onClick: activate,
          disabled: activate === undefined,
          title: t("chatAction"),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            border: "0.5px solid var(--dsw-alias-border-l3)",
            borderRadius: 999,
            background: "transparent",
            color: SECONDARY,
            font: "inherit",
            fontSize: 12,
            lineHeight: 1.6,
            cursor: activate === undefined ? "default" : "pointer",
          },
        },
        t("chatAction"),
      );
    }

    /** Mount the execution-log feature: tab type, its seats, chat entry, and row redirect. */
    function mountExecLog(ctx, t) {
      const disposers = [];
      disposers.push(
        ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: "extension",
          title: () => t("title"),
          guide: [
            {
              id: "panel",
              order: 40,
              title: () => t("guideTitle"),
              description: () => t("guideDescription"),
              icon: ExecLogIcon,
            },
          ],
        }),
      );
      disposers.push(
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: ID,
              locale: NS,
              inject: () => {
                const jobs = ctx.jobs;
                if (jobs === undefined || jobs === null) return {};
                return {
                  hooks: { jobs: jobs.state },
                  watchRows: (sessionId) => jobs.watchRows(sessionId),
                  observe: (sessionId, jobId) => jobs.observe(sessionId, jobId),
                };
              },
            },
            TracePanel,
          ),
        ),
      );
      // The conversation's step headers are the buttons inside `[data-step-process]`.
      // Taking them over opens the sidebar on that step; turn rows and body text
      // keep their official behaviour.
      if (typeof document !== "undefined") {
        const onCapture = (event) => {
          if (!traceIntercept.get()) return;
          const target = event.target;
          if (target === null || typeof target.closest !== "function") return;
          const button = target.closest("button");
          if (button === null) return;
          const group = button.closest("[data-step-process]");
          if (group === null) return;
          event.preventDefault();
          event.stopPropagation();
          const turn = Number(group.getAttribute("data-chat-turn"));
          // The position is taken among every group of the turn, exactly like the
          // connectors do. Counting only the visible ones would shift the index
          // as soon as part of a long turn is scrolled out of view, and the list
          // would select the wrong step.
          const siblings = [...document.querySelectorAll("[data-step-process]")].filter(
            (candidate) => Number(candidate.getAttribute("data-chat-turn")) === turn,
          );
          const position = siblings.indexOf(group);
          if (Number.isFinite(turn) && position >= 0) {
            traceFocus.set({ turn, position });
          }
          try {
            ctx.sidebarRight.openTab(KIND);
          } catch (error) {
            console.error("[ui-exec-log] opening the panel failed:", error);
          }
        };
        document.addEventListener("click", onCapture, true);
        disposers.push(() => document.removeEventListener("click", onCapture, true));
      }
      // Mind-map connectors: visible conversation steps → their list rows.
      disposers.push(
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            { name: "shell.overlay", id: "fzl-trace-curves", order: 60 },
            TraceCurves,
          ),
        ),
      );
      disposers.push(
        ctx.slots.inject("sidebar.right.pane.tab.title", () =>
          ctx.slots.register(
            { name: "sidebar.right.pane.tab.title", key: ID, locale: NS },
            ExecLogTitle,
          ),
        ),
      );
      return combine(disposers);
    }

    /** Mount the plain plugin view: header switch plus the tab takeover while plain mode is on. */
    function mountPluginView(ctx, t) {
      const disposers = [];
      disposers.push(
        ctx.slots.inject("settings.action", () =>
          ctx.slots.register(
            { name: "settings.action", id: "exec-log-view", order: 20, locale: NS },
            PluginViewSwitch,
          ),
        ),
      );
      // In plain mode this plugin takes the official tab's cell; withdrawing the
      // registration lets the shipped entry win again.
      let registration;
      const withdraw = () => {
        if (registration === undefined) return;
        const dispose = registration;
        registration = undefined;
        dispose();
      };
      const sync = () => {
        withdraw();
        if (pluginViews.get() !== "plain") return;
        registration = ctx.slots.inject("settings.plugins.tab", () =>
          ctx.slots.register(
            {
              name: "settings.plugins.tab",
              id: "all",
              order: 10,
              label: () => t("tabLabel"),
              locale: NS,
              priority: 10,
              inject: () => {
                const remote = ctx.remote;
                const manager = remote === undefined || remote === null ? undefined : remote.pluginManager;
                return {
                  // Localized display text may arrive as a string or a locale map.
                  resolveText: (value) => {
                    try {
                      return ctx.locale.resolveText(value);
                    } catch (error) {
                      return typeof value === "string" ? value : undefined;
                    }
                  },
                  fetchBundles: manager === undefined || manager === null ? undefined : () => manager.listBundles(),
                  setBundleEnabled:
                    manager === undefined || manager === null
                      ? undefined
                      : (name, enabled) => manager.setBundleEnabled(name, enabled),
                };
              },
            },
            PluginGuideTab,
          ),
        );
      };
      const unsubscribe = pluginViews.subscribe(sync);
      sync();
      disposers.push(() => {
        unsubscribe();
        withdraw();
      });
      return combine(disposers);
    }

    /** Mount the Session delete feature: the Session row menu entry. */
    function mountSessionDelete(ctx) {
      return combine([
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "fzl-delete-session",
              order: 500,
              locale: NS,
            },
            SessionDeleteMenuItem,
          ),
        ),
      ]);
    }

    /**
     * Client plugin body.
     *
     * The three switches are independent: each gate owns exactly the seats of one
     * feature, so turning one off withdraws that feature and nothing else. The
     * settings page that owns the switches stays mounted, because a feature
     * switched off must remain switchable from the UI.
     *
     * @param ctx - client root context carrying slots, locale and the Sidebar registry.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      aboutRemote = ctx.remote === undefined ? undefined : ctx.remote;
      aboutLocale = ctx.locale === undefined ? undefined : ctx.locale;

      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "ui-exec-log: copy",
      );

      gateFeature(ctx, "execLog", () => mountExecLog(ctx, t), "fzl-toolkit: execution log");
      gateFeature(ctx, "sessionDelete", () => mountSessionDelete(ctx), "fzl-toolkit: session deletion");

      // The plugin's own page in the Plugins list: the switches live with the
      // bundle they belong to, between its description and its rows.
      ctx.effect(
        () =>
          ctx.slots.inject("plugins.bundle.config", () =>
            ctx.slots.register(
              { name: "plugins.bundle.config", key: ID, locale: NS },
              FeatureSwitches,
            ),
          ),
        "fzl-toolkit: plugin page switches",
      );

      // Toolkit: one settings page that lists this package's features and their switches.
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "fzl-toolkit",
                order: 16,
                label: () => t("toolkitNav"),
                locale: NS,
              },
              ToolkitSection,
            ),
          ),
        "fzl-toolkit: settings section",
      );

      // About DSH: one settings page for the installation itself - the version
      // and paths it runs from, the disk layout, and the plugins it composed.
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "dsh-about",
                order: 100,
                label: () => t("aboutNav"),
                locale: NS,
                // Best effort: a namespace this plug-in may not call throws on
                // access, and the page then reads the Remote it captured in
                // `apply`. Either way the section must not fail to mount.
                inject: () => {
                  try {
                    const remote = ctx.remote;
                    if (remote === undefined || remote === null) return {};
                    const manager = remote.pluginManager;
                    const inventory = remote.pluginInventory;
                    return {
                      listBundles: manager === undefined || manager === null ? undefined : () => manager.listBundles(),
                      listInventory: inventory === undefined || inventory === null ? undefined : () => inventory.list(),
                    };
                  } catch (error) {
                    return {};
                  }
                },
              },
              AboutSection,
            ),
          ),
        "fzl-toolkit: about section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Pure helpers and components, exported so the panel can be unit-tested in node. */
    exports.__internals = {
      buildTurns,
      targetOf,
      formatMs,
      formatCount,
      formatClock,
      prettyJson,
      readResult,
      durationOf,
      ChatAction,
      revealCallInChat,
      redirectProcessClick,
      PluginViewSwitch,
      PluginGuideTab,
      PluginGuideList,
      PluginGuideCard,
      pluginGuideRows,
      pluginViews,
      usePluginView,
      ExecLogTitle,
      ToolkitSection,
      AboutSection,
      AboutBody,
      pluginGraph,
      layoutUrl,
      FeatureCard,
      FeatureSwitches,
      featureFlags,
      useFeatures,
      gateFeature,
      SessionDeleteMenuItem,
      toolkitRequest,
      formatBytes,
      formatWhen,
      TracePanel,
      TraceCurves,
      TraceDetail,
      traceBridge,
      traceSummary,
      traceFirstLine,
      paintTraceCurves,
      pickFocusStep,
    };
    return module.exports;
  },
});
