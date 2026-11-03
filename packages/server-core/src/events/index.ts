/**
 * Event Center — public surface for hosts.
 *
 * Modules outside this package (Electron main, the web server) import from
 * here rather than reaching into individual files, so the internal layout can
 * change without touching hosts.
 */

export { EventService, getEventService, getExistingEventService, stopAllEventServices, listListenersFor, getListenerFor } from './event-service.ts'
export type { EventServiceOptions, EventServiceStatus, ListenerView } from './event-service.ts'
export { EventIngestServer } from './ingest-server.ts'
export type { EventIngestAddress, EventIngestOptions, EventSink } from './ingest-server.ts'
export { ListenerSupervisor } from './listener-supervisor.ts'
export type { ListenerProcessState, ListenerRuntimeStatus, SupervisorOptions } from './listener-supervisor.ts'
export { loadListeners, setListenerEnabled, setListenerConfig, missingConfigKeys, clearProbeCache } from './listener-registry.ts'
export type { DependencyStatus, DependencyState, LoadedListener } from './listener-registry.ts'
export { EventDispatcher } from './event-dispatcher.ts'
export type { DispatchTarget, EventDispatcherOptions } from './event-dispatcher.ts'
export { buildInstallCommand, formatInstallCommand, runInstallCommand } from './dependency-installer.ts'
export type { InstallResult } from './dependency-installer.ts'
