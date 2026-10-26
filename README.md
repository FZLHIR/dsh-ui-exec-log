# dsh-ui-exec-log

DSH 插件：右侧「执行轨迹」面板 + 会话删除。

## 功能

- **执行轨迹**（`sidebar.right.pane.tab`）
  - 轮 → 步 → 行（思考 / 助手正文 / 工具）三级树，步头用官方活动句（已读取文件并执行了命令…）。
  - 流式思考：仅末尾段自动展开、随后出现工具即自动收起；流式中容器自动跟到底。
  - 点对话里的步头 → 打开面板并定位该步；点面板里的步/轮 → 反向定位对话并描边。
  - 可选连线层、可选 CoT 翻译（走 Host `translator` 服务，匿名 provider 会把文本发给翻译服务）。
  - 面板右上「设置」弹窗内三个开关，状态持久化在 `localStorage`。
- **会话删除**（侧栏会话菜单项）：删除磁盘会话并清理内存中的 Session/Agent 引用，不留下幽灵行。
- **关于 DSH**（设置页最后一项）：版本、配置档、安装根、数据目录；左栏「文件框架」按职责列出启动入口、应用本体、harness 运行时、数据目录、配置档、会话日志、工作区等关键位置（不逐个列文件，体积只给关键几项），并给出该配置档的 bundle 与补丁组成；右栏「插件架构」由 Host 服务读取，包 → 条目 → 加载阶段，含 Agent 预设。只读。

## 安装

在 DSH 的「添加插件」对话框里填：

1. **GitHub（推荐）**：`https://github.com/FZLHIR/dsh-ui-exec-log`

   profile 记录的规格是 `github:FZLHIR/dsh-ui-exec-log`；包被装进 profile 自己的
   `node_modules`，与本地仓库目录无关 —— 之后删掉或移动克隆都不影响加载。

2. **本地目录（仅开发用）**：填仓库目录（含本 `package.json` 的那层）。

   这条路径 pnpm 建的是**符号链接**：`node_modules/@local/dsh-ui-exec-log` 直接
   指向该目录。好处是改完即时生效，代价是：

   - 不要删除或移动源目录，否则下次加载会 `ENOENT`；
   - 想换成 GitHub 安装时，先卸载旧的本地依赖并**重启 DSH**。运行中的宿主会缓存
     旧解析路由，只换安装源、不重启，会出现
     「组件启用失败 … failed to import: Error: ENOENT: no such file or directory」。

npm 暂不支持：包名在 `@local` 作用域下，无法发布到公共 registry。

装完在「插件」页启用该 bundle，重载界面即可在右侧栏看到「执行轨迹」。

## 开发

- `client.js`：客户端（Cordis client plugin，`window.__ModuleLoader__.load`）。
- `index.js`：Host 半（会话删除、翻译与安装布局路由）。
- 自测：`node __model-selftest.mjs`、`node __feature-selftest.mjs`、`node __delete-selftest.mjs`、`node __layout-selftest.mjs`、`node __about-render-selftest.mjs`。

## 注意

- 切换「翻译」后，展开的思考会发给所选翻译服务（Bing/Google 匿名端点，无需登录，可能被限流）。
- 面板依赖官方对话 DOM 契约（`data-step-process`、`data-chat-turn`、`aria-expanded`）；官方改版时相关功能降级为不干预。
