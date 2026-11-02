# 策略组切换单位改造方案

> 目标：让「策略组里选中的 N 个模型」成为 N 个真正可切换的单位，而不是共用同一个 provider 的一个入口。
>
> 现状源于 261027-long-bronze：策略组里配了 3 个模型（`deepseek-v4.1-flash` / `hy4-preview` / `hy3`），
> 实际只有 1 个可尝试单元，第一次 404 就把唯一 key 冷却 60s，之后 9 次请求在网关本地全部被拒。

## 0. 实现状态（已落地）

P1–P4 已全部实现并通过类型检查与测试：

| 项 | 落地内容 |
|---|---|
| 配置 | `members[].model` / `upstreamModel` / `enabled`；`strategy.switchPolicy`；`preset.routeSeconds`（默认 300） |
| 规划 | `candidateUnits()` + `plan.units`：一个公开名可展开为多个 `(provider, upstreamModel)` 单元，按声明顺序 |
| 执行 | `execute()` 按单元迭代；单元内仍是 key 阶梯；每次尝试记录 `unitId` |
| 冷却 | key / route（`provider::upstreamModel`）/ endpoint 三层；404 只冷路由，不再冻住整个账户 |
| 状态码 | 余额 → 402，限流墙 → 429，无可用单元 → 503，仅未分类失败 → 502；响应体与日志行共用同一判定 |
| 可观测 | 失败信息带上游 body 前 200 字符；使用记录与日志新增「单元」列 |
| UI | 策略卡显示单元数与切换顺序；编辑弹窗按单元排序（↑/↓），保存写 `members[].model` |
| 兼容 | 未写 `model` 的成员行为与旧版完全一致；`modelProviders` 仍写入供旧版本回滚 |

> 单元 id 以**上游模型**为键：`provider::upstreamModel`。同一个公开名在两个 provider/两个上游 id 上是两条独立路由，
> 用公开名做键会把第二条悄悄去重掉。

## 1. 现状（代码事实）

| 概念 | 代码位置 | 当前语义 |
|---|---|---|
| 策略成员 | `LlmStrategy.members: {provider, weight?}[]` | **只有 provider**，没有 model |
| 模型别名 | `modelAliases: Record<publicModel, upstreamModel>` | 策略级全局，一个公开模型只能映射**一个**上游 id |
| 模型-提供商约束 | `modelProviders: Record<publicModel, providerId[]>` | 只决定「这个模型允许走哪些 provider」，不产生切换顺序 |
| 规划 | `llm-planner.ts → planRequest()` | 遍历 `members` 得到 provider 列表；`publicModel` 全程不变 |
| 执行 | `llm-gateway.ts → execute()` | 遍历 `plan.providers`；provider 内换 key |
| 可用性 | `llm-gateway.ts → unavailableProvidersFor()` | provider 的所有 key 冷却 → 整个 provider 被排除 |

由此得出三条硬约束：

1. **切换单位 = provider**。同一个 provider 下的 3 个模型只是 3 个入口，不构成 3 个单元。
2. **模型在整个请求内不可变**。跨 provider 重试时仍发送同一个 `payload.model`，只是别名解析出的上游 id 可能不同。
3. **没有配置层的绕过办法**。把 3 个模型拆成 3 个 provider 也不行：`resolveUpstreamModel` 找不到映射时会退化成「把公开名当上游 id 发出去」，第二个 provider 依然 404。

## 2. 目标语义

切换单位定义为 **route = (provider, publicModel, upstreamModel)**：

```
策略组 workbuddyCN
├── 单元 1  workbuddycn / deepseek-v4.1-flash   keys: k1, k2, k3
├── 单元 2  workbuddycn / hy4-preview           keys: k1, k2, k3
└── 单元 3  workbuddycn / hy3                   keys: k1, k2, k3
```

一次请求的升级顺序（保持现有语义，只把「provider」换成「unit」）：

```
同一 key 重试 (retry.maxAttempts)
  → 换本单元下一个 key (最多 MAX_KEY_TRIES_PER_PROVIDER)
    → 换下一个单元
      → 换 fallbackStrategyId 指向的下一个策略
```

用户例子 `A-A1 → B-A1 → B-B1` 对应 3 个单元，其中前两个 `publicModel` 相同（A1）、provider 不同，
第三个 `publicModel` 不同（B1）。

## 3. 配置变更（加法式，version 仍为 1）

```jsonc
{
  "id": "workbuddycn",
  "type": "round_robin",
  "members": [
    { "provider": "workbuddycn", "model": "deepseek-v4.1-flash", "weight": 1 },
    { "provider": "workbuddycn", "model": "hy4-preview" },
    { "provider": "workbuddycn", "model": "hy3" }
  ],
  "modelAliases": { "deepseek-v4.1-flash": "deepseek-v4.1-flash" },
  "switchPolicy": {
    "rate_limit": "next-key",
    "quota": "next-key",
    "auth": "next-key",
    "model_not_found": "next-unit",
    "transport": "next-unit",
    "server_error": "retry-same"
  }
}
```

```ts
interface LlmStrategyMember {
  provider: string;
  /** 新增：该成员服务的公开模型名；缺省 = 任意模型（兼容旧配置）。 */
  model?: string;
  /** 新增：该成员专用的上游模型 id，优先于 modelAliases。 */
  upstreamModel?: string;
  weight?: number;
  enabled?: boolean;
}
```

要点：

- `model` 缺省时行为与今天**完全一致**（provider 级单元），旧配置零迁移。
- `model` 存在时，该成员只在该公开模型被请求时进入候选。
- `modelAliases` 保留为「公开名 → 上游名」的默认映射；`member.upstreamModel` 用来表达
  「同一个公开名 A1 在 A 家和 B 家是不同的上游 id」——这是当前 schema 表达不了的。
- `modelProviders` 保留但标记为 deprecated：它等价于「给每个列出的 provider 生成一个带 `model` 的成员」，
  加载时若两者同时存在，以 `members[].model` 为准。

## 4. 代码改动点

### 4.1 规划器（`llm-planner.ts`）

```ts
export interface PlannedUnit {
  memberIndex: number;
  provider: LlmProvider;
  publicModel: string;
  upstreamModel: string;
  weight: number;
}

export interface Plan {
  strategyId: string;
  units: PlannedUnit[];      // 取代 providers
  ...
}
```

- 过滤：`member.model` 为空 → 通用成员；`member.model === publicModel` → 精确成员。
- 顺序：保持 `members` 声明顺序；`round_robin` / `least_busy` / `weighted` 只在**同一 provider 的多个单元**
  之间按算法重排（避免把不同模型的成本混在一起算权重）。
- 可用性：逐个单元判断，见 4.2。
- 失败信息保留原因：`no_member_for_model` / `all_cooling` / `outside_window`，
  不再统一成一句 "no usable providers"。

### 4.2 可用性（`llm-gateway.ts → unavailableProvidersFor`）

改为 `unavailableUnitsFor(strategy, publicModel)`，逐个单元判断：

1. 该 `upstreamModel` 是否在 `provider.timeWindows[publicModel]` 窗口内；
2. `pool.availability(upstreamModel)` 是否至少有一个可用 key；
3. 该 unit 是否处于 **route 冷却**（见 4.3）。

返回单元列表 + 排除原因；`allLimited` 的判定改为「全部单元都是限流导致」，不再依赖 provider 粒度。

### 4.3 冷却范围（新增 route 层）

现在的冷却只有 key 粒度（`KeyPool` 里 `cooldownKey(providerId, keyId)`）。加入 route 粒度：

| 上游失败 | 判定 | 冷却范围 | 时长 |
|---|---|---|---|
| 429 | `rate_limit` | key | `preset.rateLimitSeconds` |
| 402 / 余额关键词 | `quota` | key | `preset.quotaExhaustedSeconds` |
| 401 / 403 | `auth` | key | 同 quota（换 key 有意义） |
| 400 / 404 / 422（模型不存在、参数不合法） | `route` | **unit（provider+model）** | 新增 `preset.routeSeconds`，默认 300 |
| 连接失败 / 首字节超时 | `transport` | provider（baseUrl） | `preset.defaultSeconds` |
| 5xx | `server` | key → 换 key 后仍失败则 unit | `preset.defaultSeconds` |

关键点：**404 不再冷却 key**。当前实现里 404 会把 key 冷却 60s，导致该 provider 的其它模型也一起不可用——
这正是 9 条本地 503 的直接原因。route 冷却让「hy4 不可用」不影响「deepseek-v4.1-flash」。

持久化：`llm-cooldowns.json` 的键从 `provider::key` 扩展为 `provider::key` 与 `provider::model`，
加载时按前缀区分（现有文件可直接读）。

### 4.4 执行器（`llm-gateway.ts → execute`）

- 外层循环 `for (const unit of plan.units)`；内层 key 阶梯不变。
- 每个单元用 `unit.upstreamModel` 改写请求体（今天已在用 `plan.modelAliases` 做，改为单元自带）。
- 成功时 `lastModels` 记录 `unit.publicModel @ unit.upstreamModel`；`noteRoute` 的切换判定加入
  `unitId`，`reason` 增加 `model`（已有该枚举值）。
- 每个尝试行写入 `unitId`，日志新增「单元」列（`provider/model`），并保留 `superseded`。
- `stickySession` 的键加入 `unitId`，避免固定到某个单元后其它单元永远冷启动。

### 4.5 状态码与可观测性

当前 `classifyUpstreamFailure` 把 400/403/404 一律当 `deterministic`，`402` 当 `quota` 并最终答 429。
建议：

| 场景 | 客户端状态 |
|---|---|
| 余额/配额耗尽 | **402** `insufficient_balance`（带上游摘要） |
| 全部单元限流 | 429 `rate_limit_error` + `Retry-After` |
| 模型无任何单元可服务 | 400 `invalid_request_error`（配置/模型错） |
| 单元全部因 route/transport 冷却 | 503 `no_healthy_account` |
| 其它未分类上游失败 | 502（保留，但 `error` 里带上游状态码 + body 前 200 字符） |

日志 `error` 字段必须带上游状态码与 body 摘要（当前只有 `upstream workbuddycn returned 404`，
排查时看不到 relay 的真实原因）。

## 5. 兼容与迁移

- `members[].model` 缺省 = 旧行为，`llm-config-loader.ts` 无需迁移，只加校验：
  - `model` 必须是非空字符串；
  - 同一策略内 `(provider, model)` 不得重复；
  - 若给了 `upstreamModel`，provider 的 `models` 里应能找到对应公开名（或明确作为自定义映射）。
- 旧版本读到带 `model` 的成员会忽略该字段并退化为 provider 级单元 → 可安全回滚。
- UI 迁移：`modelProviders` 存在时，加载后提示「可转换为 N 个切换单元」，用户确认后重写为 `members[].model`。

## 6. UI 改动

- 策略组编辑页：由「选提供商」改为「切换单元列表」，每行 `提供商 + 模型 + key 数 + 拖拽排序`。
  没有 key 的单元显示提示：「无 key，将使用 1 个匿名账户」。
- 卡片/日志：显示单元而非仅 provider；`错误聚合` 按单元聚合。
- 单元校验：provider 必须启用；模型必须在该 provider 的 `models` 或 `modelAliases` 中；
  重复单元直接拒绝保存。

## 7. 分阶段落地

| 阶段 | 内容 | 状态 | 验收 |
|---|---|---|---|
| P1 | `members[].model` + planner 单元化 + execute 单元循环 | ✅ 已完成 | planner 38 条 + gateway 46 条测试全绿 |
| P2 | route 冷却 + 错误分类拆分 + 状态码映射 | ✅ 已完成 | `llm-switch-units.test.ts` 7 条：单元回退、路由冷却隔离、402、body 摘要、policy stop |
| P3 | UI 单元列表 + 顺序编辑 + 配置校验 | ✅ 已完成 | 策略卡显示「N 个切换单元」与顺序；弹窗 ↑/↓ 即试错顺序；加载器拒绝重复单元 |
| P4 | 文档 + 使用记录新增 `unitId` 列 | ✅ 已完成 | 日志新增「单元」列，旧行显示 — |

## 8. 风险

- **上下文窗口不一致**：同一策略里的单元可能来自不同窗口的模型（hy3 960k vs deepseek 1M）。
  单元切换后宿主仍按会话自认为的模型计算 compaction reserve（`applyPiResilienceSettings`）。
  `onRouteChanged` 现在已带 `unitId`，后续可据此回传实际 `contextWindow`。
- **提示缓存失效**：切模型等于换缓存域，`compactAfterSwitch` 已有开关，建议在模型级切换时默认触发。
- **成本不可比**：`weighted` / `least_busy` 若跨模型加权，会把便宜模型和贵模型当成同一池子；
  P1 里限定「算法只在同 provider 的单元间重排」，跨 provider 仍按声明顺序。
- **旧客户端模型名**：客户端仍用公开名请求；单元切换后响应的 `model` 字段保持公开名，避免客户端不认。

## 9. 使用方式

在设置页「策略组 → 编辑」里，选中的每个（提供商, 模型）就是一个切换单元，列表的上下顺序就是
网关的尝试顺序。`A-A1 → B-A1 → B-B1` 的配置方式：

```jsonc
"members": [
  { "provider": "a", "model": "A1" },
  { "provider": "b", "model": "A1", "upstreamModel": "b-a1" },
  { "provider": "b", "model": "B1" }
]
```

请求 `A1` 时只走前两个单元（第三个只服务 `B1`）；`upstreamModel` 用来表达「同一个公开名在 B 家是不同的上游 id」。

旧配置不需要迁移：没有 `model` 的成员仍然表示「该提供商的任意模型」，行为与改造前一致。
