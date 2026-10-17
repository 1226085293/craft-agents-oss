# 更新 Craft Agents 本地安装的指南

## ⚠️ 重要：更新本机安装的 Craft Agents

当用户要求"更新你自己"或"拉取最新代码并重启"时，**必须使用完整的更新脚本**，不能只运行构建命令。

## 正确的更新流程（Windows）

### 方法 1：使用完整更新脚本（推荐）

```powershell
cd E:\craft-agents-oss
.\build-install-restart-win.ps1
```

这个脚本会：
1. 构建 NSIS 安装包
2. 停止正在运行的 Craft Agents 进程
3. 运行静默安装到 `%LOCALAPPDATA%\Programs\@craft-agentelectron\`
4. 自动启动新版本的应用

### 方法 2：手动步骤（了解原理）

如果脚本失败，可以手动执行以下步骤：

```powershell
# 1. 拉取最新代码
cd E:\craft-agents-oss
git pull origin main

# 2. 构建安装包（需要几分钟后完成）
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-install-restart-win.ps1

# 3. 等待脚本自动完成安装和重启
```

## ❌ 错误的做法（会导致更新失败）

### ⚠️ Agent 会话内更新（重要注意事项）

当 **Craft Agents 的 agent 会话**（非人工终端）执行更新时：

1. **不要不带 `-SkipProcessKill` 直接运行完整构建**——
   `build-win.ps1` 默认会终止所有 `node` / `npm` / `electron` / `electron-builder` 进程，
   这会**杀掉调用者自己的命令管道**（表现为立刻 `Command timed out after 2 seconds`），
   甚至可能波及宿主应用。这是 2026-10-10 实测踩坑。
   **带上 `-SkipProcessKill` 就是安全的**（含 electron-builder 重试分支）。
2. **推荐在 agent 会话内走后台独立打包**，二选一：

   **A. 一条命令跑完整管线（推荐）**：构建 → 校验 installer 时间戳 → 安装 → 重启，一次调用完成：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\build-install-restart-win.ps1" -SkipProcessKill -SkipDependencyInstall
   ```

   - `-SkipProcessKill`：**agent 会话内必带**，否则 `build-win.ps1` 会杀掉 node/npm（含调用者自己的管道）。
   - `-SkipDependencyInstall`：依赖未变时用，省 2-3 分钟。
   - 只构建不安装：改用 `apps/electron/scripts/build-win.ps1`（同两个开关，含全部 staging）。

   **B. 快捷路径（仅刷新 dist，staging 产物已知最新时）**：先 `bun run electron:build`，
   再用 `Start-Process` 后台运行 electron-builder，**工作目录必须是 `apps/electron`**
   （`afterPack.cjs` 在 `apps/electron/scripts/` 下，`electron-builder.yml` 中的相对路径
   按工作目录解析——从仓库根目录运行会报 `Cannot find module '...scripts\afterPack.cjs'`，
   2026-10-12 实测踩坑）：

   ```powershell
   Start-Process -FilePath '<repo>\node_modules\.bin\electron-builder.exe' -ArgumentList '--win','--x64' -WorkingDirectory '<repo>\apps\electron' -WindowStyle Hidden -RedirectStandardOutput '<repo>\packaging.log' -RedirectStandardError '<repo>\packaging-err.log' -PassThru
   ```

   - 优先用 `node_modules\.bin\electron-builder.exe`（`bun install` 不生成 .cmd shim，
     裸 `npx`/`bunx` 在部分环境不可用，与 `build-win.ps1` 的调用方式保持一致）。
   - 快捷路径**不含 staging**：若依赖升级过或 `vendor/bun`、SDK、ripgrep 可能过期，
     走 A，或逐项核对时间戳后再走 B。
   - 启动前删除旧安装包 `apps/electron/release/*.exe`，避免误装旧包（10-10 incident）。
   - 轮询日志直到 exe 时间戳更新，再核对时间戳（见下一条）。
3. **安装前必须核对安装包时间戳**：`apps/electron/release/Craft-Agents-x64.exe`
   （不是仓库根目录的 `release/`）的 `LastWriteTime` 必须晚于本次构建开始时间。脚本已内置校验（构建模式下拒绝旧包），但手动运行时
   仍要自查——2026-10-10 曾因打包被截断而误装 18:27 旧包，用户看到旧版界面。
4. 安装/重启默认已由上一条命令完成（脚本内部用 detached helper 处理宿主中断，
   脚本本身安全）。只有"已构建好、只想安装"时才单独跑
   `build-install-restart-win.ps1 -SkipBuild`。

### 验证更新是否成功（Windows）

安装完成后在 agent 会话内核查：

```powershell
# 1. helper 日志（安装器退出码必须为 0，且出现新 PID）
Get-Content "$env:TEMP\craft-agents-install-restart-*.log" | Select-Object -Last 8

# 2. 安装目录 main.cjs 时间戳 ≈ 本次构建时间（不是旧版本时间）
(Get-Item "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\dist\main.cjs").LastWriteTime

# 3. 确认记忆系统特征已打包（embedding 单轨：bge-small-zh 模型 + 语义检索）
Select-String -Path "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\dist\main.cjs" -Pattern "encodeText","No embedding model path resolved" | Select-Object -First 2
# 3b. 确认 transformers 是 external（非内联）：main.cjs 里应有 `import("@huggingface/transformers")`，
#     且不应出现 onnxruntime_binding（内联会裁剪 native binding 导致主进程 embedding 失效）
(Get-Content "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\dist\main.cjs" -Raw) -match 'import\("@huggingface/transformers"\)'
# 4. 确认内置 embedding 模型在安装目录（模型随安装位置走，装 D 盘即在 D 盘）
Test-Path "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\dist\resources\models\bge-small-zh-v1.5\onnx\model_quantized.onnx"
# 5. 确认 embedding 运行时依赖齐全（onnxruntime-common 是传递依赖，缺了会 ERR_MODULE_NOT_FOUND）
Test-Path "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\node_modules\onnxruntime-common\package.json"
Test-Path "$env:LOCALAPPDATA\Programs\@craft-agentelectron\resources\app\node_modules\@huggingface\transformers\package.json"
```

## 补充踩坑（2026-10-12 重建实测）

- **`git pull` 报 TLS 瞬断**（`unexpected eof while reading` / `error:0A000126`）：
  多为网络抖动，直接重试即可；重试前先 `git fetch` 确认远端 HEAD。
- **bash 中调用 `powershell -File .\xxx.ps1`**：反斜杠会被转义吞掉（变成
  `.build-...ps1` 报"文件不存在"），一律用**绝对路径**（Git Bash 里写
  `"E:\craft-agents-oss\build-install-restart-win.ps1"`）。
- **bash 中 `powershell -Command` 引用 `$env:` 变量**：`$env` 会被 bash 展开为空，
  整个 `-Command` 参数必须用**单引号**包裹（或写入 .ps1 文件执行）。
- **快捷路径 staging 核对清单**（B 路径适用）：
  - `apps/electron/vendor/bun/bun.exe` 存在且可独占打开
  - `apps/electron/node_modules/@anthropic-ai/claude-agent-sdk` 与
    `claude-agent-sdk-binary`（含 ~210MB `claude.exe`）时间戳 ≥ 依赖更新后最近一次构建
  - `apps/electron/node_modules/@vscode/ripgrep/bin/rg.exe` 与
    `node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe` 内容一致（`cmp` 核对）
  - `apps/electron/dist/interceptor.cjs`、`packages/messaging-whatsapp-worker/dist/worker.cjs`、
    `packages/pi-agent-server/dist/index.js` 时间戳 ≥ 对应源码最近修改时间
  - **embedding 运行时（2026-10-13 新增）**：
    - `apps/electron/dist/resources/models/bge-small-zh-v1.5/onnx/model_quantized.onnx` 存在（~24MB，内置记忆模型）
    - 打包后 `resources/app/node_modules/@huggingface/transformers`、`onnxruntime-web`、
      `onnxruntime-node`、`onnxruntime-common`、`sharp` 均在（embedding 引擎运行时依赖；
      `onnxruntime-common` 是 transformers 的传递依赖，electron-builder 的 npm collector
      在 bun monorepo 下不递归收集传递依赖，必须显式声明为依赖 + extraResources 拷贝——
      缺了会 ERR_MODULE_NOT_FOUND，embedding 全挂、记忆全不注入——2026-10-13 实测坑）
    - **main.cjs 必须 external `@huggingface/transformers`**（esbuild `--external`，
      build:main / build:main:win / build-win.ps1 三处同步）：若内联，esbuild 会
      dead-code-eliminate 掉 onnxruntime-node 的 native binding 加载器，主进程
      （encodeEmbedding 回调运行处）embedding 静默失效——这是"语义检索不命中"的真凶
  - 构建链尾会运行 `bun scripts/validate-assets.ts`（main.cjs/preload/interceptor/renderer/
    pi-agent-server/模型/内置资产存在性校验；缺失任一即报错退出，防止带病打包）

## ❌ 错误的做法（会导致更新失败）

### 错误 1：只运行构建命令
```powershell
# ❌ 这只构建产物，不会安装或重启——把它当作"完整更新"是错的。
# （作为 agent 快捷路径的打包前置步骤是允许的，见上方 A/B 选项 B。）
bun run electron:build
```

### 错误 2：只构建主进程
```powershell
# ❌ 这只是部分构建，不完整
bun run electron:build:main
```

### 错误 3：直接运行 Electron
```powershell
# ❌ 这启动的是开发版本，不是安装版本
bun run electron:start
```

## 正确的更新流程（Linux）

### 方法 1：开发环境更新（直接在仓库目录运行）

```bash
cd /path/to/craft-agents-oss

# 1. 拉取最新代码
git pull origin main

# 2. 构建子进程（MCP servers）
# ⚠️ 若 `bun` 不在 PATH（agent 会话内常见），先导出，否则子脚本报 bun: command not found
# export PATH=/root/.bun/bin:$PATH
bun run server:build:subprocess
# 2b. 可选：构建 Web UI（默认跳过，除非主动要求）
#     原因：Web UI 仅浏览器客户端使用；Telegram/API 场景无需它。构建耗时且可能 OOM（2026-08-24 实测）。
# bun run webui:build

# 3. 停止旧进程并重启（⚠️ agent 会话内勿直接执行 pkill——会杀死自己的宿主，
#    见方法 3 的警告；应使用 scripts/self-update-restart.sh 或交由用户执行）
pkill -f "packages/server/src/index.ts" || true
sleep 1
bun run packages/server/src/index.ts
```

### 方法 2：生产独立服务器构建（带嵌入式 Bun 运行时）

```bash
cd /path/to/craft-agents-oss

# 1. 拉取最新代码
git pull origin main

# 2. 构建 Linux x64 独立包（含 bun/uv 运行时 + 所有依赖）
bun run scripts/build-server.ts --platform=linux --arch=x64 --compress

# 3. 产物在 dist/server/，压缩为 craft-server-<version>-linux-x64.tar.gz
# 4. 部署到新服务器或复制覆盖现有安装
tar -xzf dist/craft-server-*.tar.gz -C /opt/craft-server

# 5. 启动（首次需生成 token）
cd /opt/craft-server && bash install.sh
# 或指定已有 token 启动：
CRAFT_SERVER_TOKEN=xxx ./start.sh

# 6. 可选：安装 systemd 服务
sudo bash install.sh --systemd
sudo systemctl start craft-server
sudo systemctl enable craft-server
```

### 方法 3：内联更新（修改源码后热替换，无需重建整个 dist）

适用于已在运行中的开发/测试环境（如 `/tmp/craft-agents-oss`）：

#### 🤖 AI agent 自主更新（推荐）

agent 在会话内完成第 1–3 步后，用自更新脚本代替手动 pkill：

```bash
# 第 4 步：脱离进程树调度重启（脚本自身不受宿主死亡影响）
setsid nohup bash /tmp/craft-agents-oss/scripts/self-update-restart.sh 20 \
    >> /tmp/craft-self-update.log 2>&1 &
```

脚本流程：延迟 20s（留时间发送最后消息）→ 精确锚定并 kill 旧后端 →
supervisord `autorestart=true` 自动拉起新进程 → 轮询 RPC 端口做健康检查 →
结果写入 `/tmp/craft-self-update.log`。全程无需用户干预。

前提条件：`/tmp/craft-agents-oss/scripts/self-update-restart.sh` 已存在，且 dist 已构建完毕——本脚本只负责"切换"。

> **Web UI 构建（默认跳过）**：内联更新时默认**不**执行 `bun run webui:build`，
> 除非用户主动要求。原因：Web UI 仅供浏览器客户端使用，Telegram/API 场景完全
> 依赖后端 + 子进程，不需要 Web UI 产物；且该构建耗时长、曾因内存不足 OOM 被杀
> （2026-08-24 实测）。需要时单独执行 `bun run webui:build` 即可，不影响已运行服务。

> ⚠️ **给 AI agent 的硬性警告**：绝不要在会话内直接执行 `pkill -f "packages/server/src/index.ts"`——
> 那会杀死你自己的宿主进程，会话立刻中断，后续重启命令永远不会被执行
> （2026-08-21 实际发生过）。要么用上面的自更新脚本，要么把重启交给用户。

### ❌ 错误的做法（会导致更新失败）

```bash
# ❌ 只构建开发版本，不会安装或重启
bun run electron:build

# ❌ 只构建主进程，不完整
bun run electron:build:main

# ❌ 直接运行 Electron（开发模式，不是生产服务）
bun run electron:start
```

## 为什么必须使用完整脚本？

Electron 应用在 Windows 上的安装过程：
1. **构建阶段**：编译 TypeScript → JavaScript，打包资源
2. **打包阶段**：创建 NSIS 安装包（`.exe` 安装程序）
3. **安装阶段**：运行安装程序，复制到 `%LOCALAPPDATA%\Programs\@craft-agentelectron\`
4. **重启阶段**：启动新安装的应用

只执行第 1 步（构建）不会更新已安装的应用，因为：
- 已安装的应用在 `%LOCALAPPDATA%`，不在仓库目录
- 需要运行安装程序才能替换已安装的文件
- 需要重启应用才能加载新代码

### Linux 服务器的特殊说明

Linux 环境下 Craft Agent 通常以**无头服务器**运行（无 GUI），通过 WebSocket RPC（默认端口 9100）对外提供服务。

- **开发环境**：直接从源码仓库 `bun run packages/server/src/index.ts` 启动
- **生产环境**：使用 `build-server.ts` 生成的独立包，内含嵌入式 Bun 运行时，无需服务器预先安装 Bun
- **内联更新**：适合容器化或临时测试环境，手动同步 dist 后重启即可

## 验证更新是否成功

```bash
# 1. 检查进程是否以新代码启动（查看启动时间）
ps aux | grep "packages/server/src/index.ts" | grep -v grep

# 2. 检查 WebSocket RPC 是否响应
node -e "const ws=new WebSocket('ws://localhost:9100'); ws.on('open',()=>{ws.send(JSON.stringify({id:'test',type:'ping'})); setTimeout(()=>ws.close(),2000)}); ws.on('message',d=>console.log(d.toString()))"

# 3. 查看日志确认无报错
tail -f /tmp/craft-server.log
```

## 故障排除

### 问题：安装器退出码 2（Installer exited with code 2）
**原因**：`build-install-restart-win.ps1` 的 helper 只杀 `Craft Agents` 主进程，
未杀 `pi-agent-server` 子进程（bun.exe）。子进程动态加载了安装目录
`node_modules/@huggingface/transformers`，持有文件句柄，NSIS 覆盖文件失败。
**解决**：helper 已修复——杀主进程后额外扫 `pi-agent-server` 子进程（排除自身
进程树）。若仍偶发，手动杀 `bun.exe`（命令行含 `pi-agent-server`）后重试。

### 问题：安装后记忆不注入 / query_memories 返回空（语义检索失效）
**排查顺序**：
1. 核对 main.cjs 是否 external transformers（见上文 3b），内联即踩坑；
2. 核对 `onnxruntime-common` 是否在安装目录 node_modules；
3. 用安装目录 node_modules 跑独立探针验证 `pipeline('feature-extraction')` 能 encode（dims=[1,512]）；
4. 检查 `memory.json` 条目是否已有 `embedding` 字段（backfill 是否成功写入）。

### 问题：更新后进程没有重启
**原因**：`pkill` 未匹配到正确进程名
**解决**：`pgrep -af "bun.*server" | xargs kill -9` 强制终止后重新启动

### 问题：构建子进程报错
**原因**：`node_modules` 未安装或依赖不兼容
**解决**：
```bash
cd /path/to/craft-agents-oss
bun install --frozen-lockfile
bun run server:build:subprocess
```

### 问题：端口 9100 被占用
**解决**：
```bash
lsof -i :9100   # 查看占用进程
kill <PID>      # 终止旧进程
```

## 参考

- 项目构建文档：`README.md` - Build from Source 部分
- 原始构建脚本：`build-install-restart-win.ps1`
- Electron 构建配置：`apps/electron/electron-builder.yml`
- Linux 服务器部署：`scripts/install-server.sh`、`scripts/build-server.ts`
