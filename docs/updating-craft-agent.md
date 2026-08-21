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

### 错误 1：只运行构建命令
```powershell
# ❌ 这只构建开发版本，不会安装或重启
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

# 2. 构建子进程（MCP servers + Web UI）
bun run server:build:subprocess
bun run webui:build

# 3. 停止旧进程并重启
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

适用于已在运行中的开发/测试环境（如 `/tmp/craft-agents-tmp`）：

```bash
# 1. 从源码仓库拉取最新
cd /tmp/craft-agents-oss
git pull origin main

# 2. 构建变更的包（以 pi-agent-server 为例）
cd /tmp/craft-agents-oss/packages/pi-agent-server
/root/.bun/bin/bun build src/index.ts --outdir=dist --target=bun --format=esm --external koffi

# 3. 将 dist 复制到运行目录
cp -r dist /tmp/craft-agents-tmp/packages/pi-agent-server/

# 4. 重启后端（触发 subprocess 重建）
pkill -f "packages/server/src/index.ts"
# 等进程完全退出后重新启动
cd /tmp/craft-agents-tmp
bun run packages/server/src/index.ts
```

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
