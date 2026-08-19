# Telegram 群组（Forum Topics）部署指南

将 Craft Agent 部署到 Linux 服务器，并接入 Telegram 群组（支持 Forum Topics）。

## 1. 概述

本文档面向部署工程师，讲述在 Linux 服务器上让 Craft Agent 通过 Telegram 群组收发消息的完整流程，包含常见故障的定位与修复。

**适用版本**：v0.9.0+（Forum Topics 支持 + 自动恢复）；当前推荐 v0.11.4。

## 2. 前置条件

- Linux 服务器（已安装 [Bun](https://bun.sh/)）
- 一个 Telegram Bot（通过 BotFather 创建，拿到 token）
- 一个已开启 **Topics** 的 Telegram supergroup，且 Bot 已被加入
- 正在运行的 Craft Agent server（端口 9100 的 WebSocket RPC）

## 3. 部署步骤

### 3.1 配置 config.json

配置文件位于：

```bash
~/.craft-agent/workspaces/{workspace-id}/messaging/config.json
```

```json
{
  "enabled": true,
  "platforms": {
    "telegram": {
      "enabled": true,
      "accessMode": "owner-only",
      "owners": [{
        "userId": "8362946740",
        "displayName": "Mark",
        "username": "mk2077"
      }],
      "supergroup": {
        "chatId": "-1004470365534",
        "title": "Mark和小三",
        "capturedAt": 1787134233946
      }
    }
  }
}
```

> ⚠️ `chatId` **必须是负数**（`-100...` 前缀），正数格式无法匹配 supergroup 消息。

### 3.2 启动服务器

```bash
pkill -f "pi-agent-server"
sleep 2
bun run packages/server/src/index.ts
```

### 3.3 生成配对码并配对

通过 WebSocket RPC（端口 9100）生成配对码：

```bash
node << 'NODEJS'
const WebSocket = require("ws");
const { randomUUID } = require("crypto");
const ws = new WebSocket("ws://localhost:9100");
let requestId = null;
ws.on("open", () => {
  ws.send(JSON.stringify({
    id: randomUUID(),
    type: "handshake",
    protocolVersion: "1.0",
    token: process.env.CRAFT_SERVER_TOKEN,
    workspaceId: "564e637f-1b0b-284e-0d12-c93236848c15"
  }));
});
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "handshake_ack") {
    requestId = randomUUID();
    ws.send(JSON.stringify({
      id: requestId,
      type: "request",
      channel: "messaging:generateSupergroupCode",
      args: ["telegram"]
    }));
  } else if (msg.type === "response" && msg.id === requestId) {
    console.log(`配对码: ${msg.result.code}`);
    console.log(`Bot: @${msg.result.botUsername}`);
    ws.close();
  }
});
setTimeout(() => ws.close(), 10000);
NODEJS
```

在 Telegram 群组话题中发送配对命令（**必须先 /pair 再 /bind**）：

```
/pair <code>@Muzzik02Bot
```

配对成功后，在已接受的话题中使用：

```
/bind
```

## 4. 关键原理

### 4.1 消息必须被"接受"

所有非私聊消息都会经过 `isAcceptedChat()` 校验，只有 `chat.id === supergroupChatId` 才会被接受：

```typescript
// telegram/index.ts:156
export function isAcceptedChat(ctx, supergroupChatId) {
  if (!ctx.chat) return false
  if (ctx.chat.type === 'private') return true  // DM 总是接受
  if (!supergroupChatId) return false            // ← 未配对时返回 false
  return String(ctx.chat.id) === supergroupChatId
}
```

未配对时所有群组消息被拒绝（日志 `telegram_chat_rejected`），因此 `/bind` 永远不会执行。

### 4.2 为什么必须 /pair 后再 /bind

- `/pair` → `bindWorkspaceSupergroup()`：校验 supergroup 类型与 Topics 状态，写入 `supergroup.chatId` 并 `setAcceptedSupergroupChatId()`。
- `/bind` 依赖已接受的群组，未配对时命令不会被路由到。

### 4.3 自动恢复（v0.9.0+）

重启时从 `config.json` 读取 `supergroup.chatId`，自动恢复已配对状态：

```typescript
// registry.ts:1208
const supergroupChatId = state.configStore.get().platforms.telegram?.supergroup?.chatId
await adapter.initialize({
  token: cred.value,
  ...(supergroupChatId ? { acceptedSupergroupChatId: supergroupChatId } : {}),
})
```

### 4.4 配对时的校验

```typescript
// registry.ts:bindWorkspaceSupergroup()
if (info.type !== 'supergroup') throw new Error('chat type is not supergroup')
if (!info.isForum) throw new Error('chat is not a forum')
adapter.setAcceptedSupergroupChatId(chatId)
```

## 5. 故障排除

### 5.1 Bot 不响应话题消息 / 日志报 `ignored non-accepted chat update`

**原因**：`chatId` 缺失或错误（未配对 / 正数格式 / 值不匹配）。

**修复**：

1. 从日志获取正确的 `chatId`（必须是负数）：

```bash
tail -f /tmp/craft-server.log | grep "inbound message update"
# 日志格式：inbound message update { chatId: -1004470365534, ... }
```

2. 将 config.json 中的 `chatId` 改为该负数，重启服务器。
3. 重新执行 `/pair` → `/bind`。

### 5.2 无法使用 /bind

未配对。先在话题中执行 `/pair <code>@BotName`。

### 5.3 配对提示 "chat is not a forum"

群组未开启 Topics。打开群组 → 设置 → 开启 "Topics"。

## 6. 最佳实践

1. `chatId` 使用 `-100` 前缀的负数格式。
2. 配对码是安全边界，妥善保管，用完即失效。
3. 配对必须校验 supergroup 类型和 Topics 状态。
4. 配置持久化后重启自动恢复，无需每次重新配对。
5. 获取 `chatId` 以日志 `inbound message update` 为准，不要凭记忆填值。

## 7. 关键日志

| 日志 | 含义 |
| --- | --- |
| `[telegram] polling started` | Adapter 启动 |
| `[telegram] accepted supergroup updated` | Supergroup 配对成功 |
| `telegram_chat_rejected` | 消息被拒绝（未配对） |
| `telegram_text_update_accepted` | 消息被接受 |
| `pairing_redeemed` | 配对码使用成功 |

## 8. FAQ

**Q：为什么 chatId 要用负数？**
Telegram supergroup 的 chatId 实际是 `-100` 前缀的负数，正数无法匹配真实消息来源。

**Q：重启后还需要重新配对吗？**
不需要。v0.9.0+ 会从 config.json 自动恢复配对状态。
