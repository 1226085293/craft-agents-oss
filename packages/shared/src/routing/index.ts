/**
 * Public surface of the routing module.
 */

export type { RouteDecision, RouteRule, RoutableEvent } from './rules.ts';
export {
  formatRouteInstruction,
  getRoutesPath,
  loadRoutes,
  matchRoute,
  ruleParallelism,
} from './rules.ts';
