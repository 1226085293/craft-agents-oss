/**
 * Public surface of the routing module.
 */

export type { RouteDecision, RouteRule, RouteRuleIssue, RoutableEvent } from './rules.ts';
export {
  findUnknownRuleAgents,
  formatRouteInstruction,
  formatRouteRuleIssue,
  getRoutesPath,
  loadRoutes,
  matchRoute,
  ruleParallelism,
} from './rules.ts';
