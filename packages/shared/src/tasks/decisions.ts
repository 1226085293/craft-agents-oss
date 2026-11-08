/**
 * Decision gate — what deserves the user's attention.
 *
 * A worker can always *ask*; the question this module answers is whether the question should
 * reach the human at all. Two failure modes matter and they pull in opposite directions:
 *
 *  - asking too much turns the inbox into noise, and a noisy inbox is ignored — indistinguishable
 *    from having no inbox;
 *  - asking too little lets an agent delete data or spend money on its own.
 *
 * **Who judges the meaning: the model that filed the request.**
 *
 * This used to re-check the request text against keyword tables — six categories, plus a routine
 * vocabulary, plus a blocked-phrase list. That is a semantic judgement performed by character
 * matching, and it failed exactly the way character matching fails: 「只读」 appeared in a worker's
 * explanation of being *blocked by* a read-only mode, the request was filed as routine, and the
 * task kept running while it needed a person. The header even claimed lexical matching was
 * necessary to avoid circularity — but the caller is the worker's own `outcome: 'needs_decision'`,
 * which is already a model judgement. Re-judging it with regexes is the circular part.
 *
 * So the rule is structural: a worker that declares it needs a decision gets one. A worker that
 * declares `delivered` or `handoff` is trusted to have decided that on its own. Nothing here
 * re-reads the sentence.
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

/**
 * Classify a request that a worker has declared it cannot proceed without.
 *
 * The worker already decided this needs a person — that is what `outcome: 'needs_decision'`
 * says, and it is a model's judgement made with the whole context in view. Nothing here
 * second-guesses it by reading the summary.
 *
 * `signals` are kept in the signature because callers still pass them, and they are the useful
 * part of the card: the commands and paths the worker named are what the person needs in order
 * to answer. They are not used to decide anything.
 */
export function assessDecisionRequest(
  summary: string,
  signals: DecisionSignals = {},
  declared?: { category?: DecisionCategory; label?: string },
): DecisionAssessment {
  const named = summary.trim();
  const commands = signals.commands?.length ? `；相关命令：${signals.commands.join(' / ')}` : '';
  return {
    needsUser: true,
    ...(declared?.category ? { category: declared.category } : {}),
    label: declared?.label ?? '需要拍板',
    /**
     * The reason describes the request, it does not classify it: a claim like 「命中高风险类别」
     * would be this module pretending to have understood the sentence.
     */
    reason: named
      ? `执行者判断需要你决定${commands}`
      : `执行者判断需要你决定${commands}`,
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
