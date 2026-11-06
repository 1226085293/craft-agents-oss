/**
 * Decision gate — what deserves the user's attention.
 *
 * A worker can always *ask*; the question this module answers is whether the
 * question should reach the human at all. Two failure modes matter and they pull
 * in opposite directions:
 *
 *  - asking too much turns the inbox into noise, and a noisy inbox is ignored —
 *    which is indistinguishable from having no inbox;
 *  - asking too little lets an agent delete data or spend money on its own.
 *
 * So the rule is a closed list of six irreversible categories. Anything that
 * does not match one of them is routine work the task was created to do, and the
 * worker is told to proceed rather than ask.
 *
 * Matching is deliberately lexical. A model judgement here would be circular:
 * the thing deciding whether to involve a model is being decided by a model.
 */

export type DecisionCategory =
  | 'destroy-data'
  | 'stop-service'
  | 'spend-money'
  | 'message-outside'
  | 'change-direction'
  | 'change-credentials';

export interface DecisionCategorySpec {
  category: DecisionCategory;
  /** Shown on the decision card, so "why am I being asked" has an answer. */
  label: string;
  /** Phrases that indicate this category. */
  patterns: RegExp[];
}

/**
 * The six categories. Order matters only for reporting the first match.
 *
 * Patterns are intentionally broad on verbs and narrow on nouns: "删除" alone is
 * routine (delete a temp file), "删除" + a data-ish object is not.
 */
export const DECISION_CATEGORIES: readonly DecisionCategorySpec[] = [
  {
    category: 'destroy-data',
    label: '删数据',
    patterns: [
      /(删除|清空|drop|rm\s+-rf|truncate|purge|wipe|delete)/i,
      /(数据库|数据表|表|索引|生产|线上|用户数据|快照|备份|仓库|分支|database|table|prod|snapshot|backup|branch)/i,
    ],
  },
  {
    category: 'stop-service',
    label: '停服',
    patterns: [
      /(停止|停掉|关闭|重启|下线|kill|stop|restart|shutdown|scale\s+to\s+0|take\s+down)/i,
      /(服务|进程|容器|集群|实例|部署|网关|service|process|container|cluster|deploy|gateway|instance)/i,
    ],
  },
  {
    category: 'spend-money',
    label: '花钱',
    patterns: [
      /(购买|付费|充值|下单|支付|开通|续费|升级套餐|purchase|buy|pay|subscribe|upgrade\s+plan|billing)/i,
    ],
  },
  {
    category: 'message-outside',
    label: '对外发消息',
    patterns: [
      /(发送|回复|通知|邮件|短信|发消息|发到|群发|对外|send|reply|email|message|notify)/i,
      /(客户|用户|外部|第三方|群|频道|邮件列表|所有人|外部\s*API|webhook|customer|client|external|channel|mailing\s+list)/i,
    ],
  },
  {
    category: 'change-direction',
    label: '改方向',
    patterns: [
      /(改方向|换个方案|放弃|重做|重构方案|推翻|调整目标|变更需求|改变计划|change\s+of\s+plan|different\s+approach|scrap|pivot|re-?scope)/i,
    ],
  },
  {
    category: 'change-credentials',
    label: '动密钥权限',
    patterns: [
      /(密钥|令牌|token|api[_\s-]?key|secret|password|密码|凭证|权限|授权|role|iam|credential|permission)/i,
      /(修改|重置|轮换|更换|删除|提升|授予|rotate|reset|change|revoke|grant|elevate)/i,
    ],
  },
] as const;

/**
 * Things a task may do without asking, even when the vocabulary overlaps.
 *
 * Checked first: "复核一下权限配置有没有过期" reads like credentials work but is a
 * read-only check, and interrupting for it would be exactly the noise this gate
 * exists to prevent.
 */
const ROUTINE_PATTERNS: RegExp[] = [
  /(巡检|检查|核对|复核|校验|审计|扫描|排查|只读|查看|统计|汇总|生成报告|巡检报告)/i,
  /(inspect|review|audit|check|scan|verify|read-?only|report|summari[sz]e)/i,
];

/** Signals the worker itself emitted while asking — cheaper than re-reading prose. */
export interface DecisionSignals {
  /** Commands the worker says it is about to run, if it listed them. */
  commands?: string[];
  /** Paths it wants to touch. */
  paths?: string[];
}

export interface DecisionAssessment {
  needsUser: boolean;
  category?: DecisionCategory;
  label?: string;
  /** Why this conclusion, for the card and the audit trail. */
  reason: string;
}

/** True when the text reads as routine work rather than an irreversible action. */
export function isRoutineWork(text: string): boolean {
  return ROUTINE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify one worker request.
 *
 * Three outcomes, in this order:
 *  1. routine vocabulary → continue without asking (the task was created for this);
 *  2. a high-risk category matches → ask, with the category on the card;
 *  3. anything else → ask. A lexical matcher can only prove "this is routine",
 *     never "this is safe": suppressing an unrecognised request is how an agent
 *     deletes something nobody classified.
 */
export function assessDecisionRequest(
  summary: string,
  signals: DecisionSignals = {},
): DecisionAssessment {
  const text = `${summary}\n${(signals.commands ?? []).join('\n')}\n${(signals.paths ?? []).join('\n')}`.trim();
  if (!text) {
    // An empty request is not evidence of routine work either.
    return { needsUser: true, label: '需要拍板', reason: '请求内容为空，无法判定为日常操作' };
  }

  if (isRoutineWork(text)) {
    return { needsUser: false, reason: '属于巡检/复核/只读类日常操作' };
  }

  for (const spec of DECISION_CATEGORIES) {
    // Every pattern in a category must be represented in the text: the first
    // pattern is the verb, the second (when present) the object.
    const hits = spec.patterns.filter((pattern) => pattern.test(text)).length;
    if (hits === spec.patterns.length) {
      return {
        needsUser: true,
        category: spec.category,
        label: spec.label,
        reason: `命中高风险类别「${spec.label}」`,
      };
    }
  }

  return {
    needsUser: true,
    label: '需要拍板',
    reason: '未识别为日常操作，交人确认',
  };
}

/**
 * The instruction handed back to a worker whose request was classified routine.
 *
 * Explicit rather than silent: a worker that asked and got no answer tends to ask
 * again, and each repeat costs a turn.
 */
export function routineContinuationNote(assessment: DecisionAssessment): string {
  return [
    '你的请求属于任务授权范围内的日常操作，不需要用户拍板，请直接继续。',
    `判定依据：${assessment.reason}。`,
    '只有删除数据、停服、花钱、对外发消息、改方向、动密钥权限这六类才需要打扰用户。',
  ].join('\n');
}
