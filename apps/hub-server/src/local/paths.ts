import path from "node:path";

function absoluteOption(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    (process.platform === "win32" && /^[\\/]$/.test(path.parse(value).root))
  )
    throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

/** Resolve before opening a database; never use the launcher's working directory. */
export function companionPaths(checkout: string, env: Record<string, string | undefined>) {
  if (!path.isAbsolute(checkout)) throw new Error("Checkout must be absolute");
  const resourceOverride = absoluteOption(env.AGENTS_HUB_RESOURCE_DIR, "AGENTS_HUB_RESOURCE_DIR");
  const dataOverride = absoluteOption(env.AGENTS_HUB_DATA_DIR, "AGENTS_HUB_DATA_DIR");
  if (resourceOverride && !dataOverride)
    throw new Error("Explicit resources require AGENTS_HUB_DATA_DIR");
  const resources = resourceOverride ?? checkout;
  const data = dataOverride ?? path.join(checkout, "data");
  const configuredDatabase = env.DATABASE_URL;
  let database = path.join(data, "agents-hub.sqlite");
  if (configuredDatabase !== undefined) {
    if (
      !configuredDatabase ||
      configuredDatabase.includes("\0") ||
      (process.platform === "win32" && /^[a-z]:[^\\/]/i.test(configuredDatabase))
    )
      throw new Error("DATABASE_URL must be a nonempty path");
    if (configuredDatabase === ":memory:") {
      database = configuredDatabase;
    } else if (path.isAbsolute(configuredDatabase)) {
      database = absoluteOption(configuredDatabase, "DATABASE_URL") as string;
    } else {
      database = path.resolve(dataOverride ?? checkout, configuredDatabase);
      const relative = path.relative(data, database);
      if (
        dataOverride &&
        (relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative))
      )
        throw new Error("Relative DATABASE_URL must stay within AGENTS_HUB_DATA_DIR");
    }
  }
  return {
    resources,
    data,
    database,
    web: path.join(resources, "apps", "web", "dist"),
  };
}
