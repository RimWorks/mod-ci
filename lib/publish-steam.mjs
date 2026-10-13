import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'semantic-release-steam';

/**
 * Maps each mod's repo path to its already-staged copy under `stageDir`, keyed by mod name
 * the way `package-mod` names the directory inside a release zip.
 */
export function stageFromDir({ mods = [], stageDir, cwd = process.cwd() }) {
  const byPath = new Map(mods.map((mod) => [resolve(cwd, mod.path), join(stageDir, mod.name)]));

  return ({ modPath }) => {
    const staged = byPath.get(resolve(cwd, modPath));
    if (!staged) throw new Error(`stageFromDir: ${modPath} has no staged copy in ${stageDir}`);
    return staged;
  };
}

/** The plugin's own options out of a semantic-release plugin list, or null if it is not in one. */
export function findSteamPlugin(plugins = []) {
  for (const entry of plugins) {
    if (entry === PLUGIN) return {};
    if (Array.isArray(entry) && entry[0] === PLUGIN) return entry[1] ?? {};
  }
  return null;
}

/**
 * Drops the Steam plugin and exec's `publishCmd` when `SPLIT_PUBLISH=1`, so the release job
 * hands those side effects to the publish jobs that read the same config without the flag.
 */
export function splitPublish(plugins, { enabled = process.env.SPLIT_PUBLISH === '1' } = {}) {
  if (!enabled) return plugins;

  return plugins.flatMap((entry) => {
    const [name, config] = Array.isArray(entry) ? entry : [entry, undefined];
    if (name === PLUGIN) return [];
    if (name === '@semantic-release/exec' && config && 'publishCmd' in config) {
      const { publishCmd, ...rest } = config;
      return [[name, rest]];
    }
    return [entry];
  });
}

/** Pushes a tagged release to the Workshop, reading the Steam plugin out of `configPath`. */
export async function publishSteam({
  configPath,
  version,
  notes = '',
  branch,
  cwd = process.cwd(),
  env = process.env,
  logger = console,
  dryRun = false,
  stageDir,
  publish,
}) {
  for (const [key, value] of Object.entries({ configPath, version, branch })) {
    if (!value) throw new Error(`publishSteam: ${key} is required`);
  }

  delete process.env.SPLIT_PUBLISH;

  const config = (await import(pathToFileURL(configPath).href)).default;
  const pluginConfig = findSteamPlugin(config?.plugins);
  if (!pluginConfig) {
    throw new Error(`publishSteam: ${configPath} has no ${PLUGIN} plugin to run`);
  }

  const steamPublish = publish ?? (await import(PLUGIN)).publish;

  await steamPublish(pluginConfig, {
    cwd,
    env,
    branch: { name: branch },
    nextRelease: { version, notes },
    options: { dryRun },
    logger,
    ...(stageDir
      ? { stageModContent: stageFromDir({ mods: pluginConfig.mods, stageDir, cwd }) }
      : {}),
  });

  return pluginConfig.mods?.map((mod) => mod.name) ?? [];
}
