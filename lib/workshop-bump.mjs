import { writeStamp } from './write-stamp.mjs';

const APP_ID = '294100';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Pushes the mod to its Workshop item with a fresh stamp. The build is deterministic, so
 * Steam only moves "Updated" when content actually changed.
 */
export async function bumpWorkshop({ workshopId, solution, modPath = process.cwd(), appId = APP_ID }) {
  if (!workshopId) throw new Error('no workshop id configured');

  // not at module scope: optional peer, and a top-level import broke every non-Steam repo
  const { stageModContent } = await import('semantic-release-steam/lib/stage-content.mjs');
  const { uploadWorkshopItem } = await import('semantic-release-steam/lib/steamcmd.mjs');

  const steamCmdPath = required('STEAMCMD_PATH');
  const steamUsername = required('STEAM_USERNAME');
  const steamConfigPath = required('STEAM_CONFIG_VDF');

  await writeStamp({ solution, modPath });
  const stagePath = await stageModContent({ modPath });

  // title, previewfile and visibility unset on purpose: the page keeps what it has
  await uploadWorkshopItem({
    steamCmdPath,
    steamUsername,
    steamConfigPath,
    stagePath,
    appId,
    publishedFileId: workshopId,
    changenote: `Weekly verification run against RimWorld ${process.env.VERIFIED_RIMWORLD ?? 'current'}. No code changes.`,
    verbose: true,
    logger: console,
  });

  return stagePath;
}
