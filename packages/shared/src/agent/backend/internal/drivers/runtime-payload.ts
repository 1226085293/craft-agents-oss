import type {
  BackendRuntimePaths,
  BackendRuntimePayload,
  DriverBuildArgs,
} from '../driver-types.ts';

/**
 * Build the runtime payload consumed by PiAgent.
 *
 * Both the native Pi driver and the direct-Anthropic driver terminate in the
 * same out-of-process Pi server, so they must hand it the same spawn paths.
 * Keeping this in one place prevents a provider from returning an empty
 * runtime payload and failing later with "piServerPath not configured".
 */
export function buildPiRuntimePayload(
  args: Pick<DriverBuildArgs, 'context' | 'providerOptions' | 'resolvedPaths'>,
  defaultPiAuthProvider?: string,
): BackendRuntimePayload {
  const { context, providerOptions, resolvedPaths } = args;

  const paths: BackendRuntimePaths = {
    piServer: resolvedPaths.piServerPath,
    interceptor: resolvedPaths.interceptorBundlePath,
    node: resolvedPaths.nodeRuntimePath,
    sessionServer: resolvedPaths.sessionServerPath,
    bridgeServer: resolvedPaths.bridgeServerPath,
  };

  return {
    paths,
    piAuthProvider:
      providerOptions?.piAuthProvider
      ?? context.connection?.piAuthProvider
      ?? defaultPiAuthProvider,
    baseUrl: context.connection?.baseUrl,
    customEndpoint: context.connection?.customEndpoint,
    customModels: context.connection?.models?.map((model) => {
      if (typeof model === 'string') return model;

      const supportsImages = typeof model.supportsImages === 'boolean'
        ? model.supportsImages
        : undefined;

      if (model.contextWindow || supportsImages !== undefined || model.maxTokens) {
        return {
          id: model.id,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(supportsImages !== undefined ? { supportsImages } : {}),
          ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        };
      }

      return model.id;
    }),
  };
}
