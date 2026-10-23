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

## 安装

DSH 里「添加插件」对话框支持三种输入：

1. 本地目录：把本仓库目录填入（含本 `package.json` 的那层）；
2. GitHub：`https://github.com/<user>/dsh-ui-exec-log`；
3. npm 包名（需先发布）。

装完在「插件」页启用该 bundle，重载界面即可在右侧栏看到「执行轨迹」。

## 开发

- `client.js`：客户端（Cordis client plugin，`window.__ModuleLoader__.load`）。
- `index.js`：Host 半（会话删除与翻译路由）。
- 自测：`node __model-selftest.mjs`、`node __feature-selftest.mjs`、`node __delete-selftest.mjs`。

## 注意

- 切换「翻译」后，展开的思考会发给所选翻译服务（Bing/Google 匿名端点，无需登录，可能被限流）。
- 面板依赖官方对话 DOM 契约（`data-step-process`、`data-chat-turn`、`aria-expanded`）；官方改版时相关功能降级为不干预。
