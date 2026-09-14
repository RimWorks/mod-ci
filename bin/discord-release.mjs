#!/usr/bin/env node
import { buildReleasePayload, postRelease } from '../lib/discord-release.mjs';

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!webhookUrl) {
    console.error('discord-release: DISCORD_WEBHOOK_URL is not set');
    process.exit(1);
}

const payload = buildReleasePayload({
    modName: process.env.MOD_NAME,
    tag: process.env.RELEASE_TAG,
    releaseUrl: process.env.RELEASE_URL,
    workshopId: process.env.WORKSHOP_ID,
    roleIds: process.env.DISCORD_ROLE_IDS ?? '',
    notes: process.env.RELEASE_NOTES ?? '',
    color: process.env.EMBED_COLOR ? Number.parseInt(process.env.EMBED_COLOR, 16) : undefined,
});

await postRelease(webhookUrl, payload);
console.log(`discord-release: announced ${payload.embeds[0].title}`);
