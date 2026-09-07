import { stageModContent } from 'semantic-release-steam/lib/stage-content.mjs';
import { uploadWorkshopItem } from 'semantic-release-steam/lib/steamcmd.mjs';
import { writeStamp } from './write-stamp.mjs';

const APP_ID = '294100';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Pushes the mod to its Workshop item with a fresh stamp. The build is deterministic, so an
 * unchanged source rebuilds byte for byte and Steam only moves "Updated" when content does.
 */
export async function bumpWorkshop({ workshopId, solution, modPath = process.cwd(), appId = APP_ID }) {
  if (!workshopId) throw new Error('no workshop id configured');

  const steamCmdPath = required('STEAMCMD_PATH');
  const steamUsername = required('STEAM_USERNAME');
  const steamConfigPath = required('STEAM_CONFIG_VDF');

  await writeStamp({ solution, modPath });
  const stagePath = await stageModContent({ modPath });

  // title, previewfile and visibility are deliberately unset so the Workshop page keeps
  // whatever it already has
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
