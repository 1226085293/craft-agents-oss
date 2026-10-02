const CRAFT_DISPLAY_NAME_KEY = '_displayName';
const CRAFT_INTENT_KEY = '_intent';

const CRAFT_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: human-friendly action name for display only.',
};

const CRAFT_INTENT_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * Return a Pi tool schema that accepts Craft's root-level metadata fields.
 *
 * Pi validates tool arguments before Craft's pre-tool-use hook can strip
 * `_displayName` / `_intent`. Built-in Pi tools often use strict schemas with
 * `additionalProperties: false`, so we add those fields as optional root
 * properties at the adapter boundary. Unknown schema shapes are returned
 * unchanged, and upstream-defined metadata properties win if Pi adds them later.
 */
export function allowCraftMetadataProperties<T>(schema: T): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(CRAFT_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[CRAFT_DISPLAY_NAME_KEY] = CRAFT_DISPLAY_NAME_SCHEMA;
  }
  if (!(CRAFT_INTENT_KEY in nextProperties)) {
    nextProperties[CRAFT_INTENT_KEY] = CRAFT_INTENT_SCHEMA;
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** Strip Craft-only metadata before invoking the upstream Pi tool implementation. */
export function stripCraftMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(CRAFT_DISPLAY_NAME_KEY in input) && !(CRAFT_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[CRAFT_DISPLAY_NAME_KEY];
  delete cleanInput[CRAFT_INTENT_KEY];

  return cleanInput as T;
}

/**
 * Normalize args where the model mistakenly prefixed a real payload key with an
 * underscore (`_command` → `command`, `_path` → `path`).
 *
 * Root cause: `_displayName` / `_intent` are the only legitimately
 * underscore-prefixed fields, and their presence primes some models (notably
 * DeepSeek) to also underscore real parameter names, which the Pi SDK then
 * rejects with "Validation failed for tool ...: command: must have required
 * properties command". This runs via `prepareArguments` BEFORE schema
 * validation, so the whole class of failures is eliminated.
 *
 * Safe by construction: only keys that (a) start with `_`, (b) are NOT the
 * metadata fields, and (c) whose bare name exists in the tool's schema
 * properties are moved. Unknown underscore keys (typeless noise) are left
 * untouched and still get stripped later.
 */
export function normalizeUnderscorePrefixedArgs<T = unknown>(args: T, schema: {
  properties?: Record<string, unknown>;
} | undefined): T {
  if (!isRecord(args)) return args;
  const props = isRecord(schema?.properties) ? schema.properties : {};
  const result = { ...args } as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(result)) {
    if (!key.startsWith('_')) continue;
    if (key === CRAFT_DISPLAY_NAME_KEY || key === CRAFT_INTENT_KEY) continue;
    const bare = key.slice(1);
    if (!bare || !(bare in props) || bare in result) continue;
    result[bare] = result[key];
    delete result[key];
    changed = true;
  }
  return changed ? (result as T) : args;
}
