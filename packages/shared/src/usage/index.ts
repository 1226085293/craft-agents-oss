/**
 * Usage Module — Source & skill usage tracking.
 *
 * See usage-store.ts for the data model and semantics.
 */

export type {
  UsageKind,
  UsageRecord,
  UsageRecordInput,
  UsageTarget,
  SkillReadUsageContext,
  UsageStats,
} from './usage-store.ts';

export {
  resolveUsageTarget,
  resolveSkillReadUsageTarget,
  appendUsage,
  readUsageRecords,
  getUsageStats,
} from './usage-store.ts';
