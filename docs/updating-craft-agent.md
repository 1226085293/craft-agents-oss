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

## 验证更新是否成功

更新完成后，检查：
```powershell
# 1. 检查安装时间（应该是刚刚）
(Get-Item "C:\Users\$env:USERNAME\AppData\Local\Programs\@craft-agentelectron\Craft Agents.exe").LastWriteTime

# 2. 检查进程启动时间（应该是刚刚）
Get-Process -Name "Craft Agents" | Select-Object Id, StartTime

# 3. 检查版本号（在应用设置 → 关于中查看）
```

## 故障排除

### 问题：更新后应用没有重启
**原因**：脚本被中断或失败
**解决**：手动运行脚本，或手动启动应用

### 问题：安装失败
**原因**：文件被占用或权限问题
**解决**：
1. 关闭所有 Craft Agents 窗口
2. 以管理员身份运行 PowerShell
3. 重新运行脚本

### 问题：更新到错误版本
**原因**：使用了错误的构建命令
**解决**：重新运行完整的 `build-install-restart-win.ps1` 脚本

## 参考

- 项目构建文档：`README.md` - Build from Source 部分
- 原始构建脚本：`build-install-restart-win.ps1`
- Electron 构建配置：`apps/electron/electron-builder.yml`
