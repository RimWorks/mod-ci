#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { ATTACHMENT_LIMIT, buildReleasePayload, postRelease } from '../lib/discord-release.mjs';

const notesFile = process.env.RELEASE_NOTES_FILE;

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
    notes: notesFile ? readFileSync(notesFile, 'utf8') : (process.env.RELEASE_NOTES ?? ''),
    color: process.env.EMBED_COLOR ? Number.parseInt(process.env.EMBED_COLOR, 16) : undefined,
});

const files = [];
const attachment = process.env.RELEASE_ATTACHMENT;
if (attachment && !existsSync(attachment)) {
    console.warn(`::warning::discord-release: ${attachment} does not exist. Announcing without it.`);
} else if (attachment) {
    const size = statSync(attachment).size;
    if (size > ATTACHMENT_LIMIT) {
        console.warn(`::warning::discord-release: ${attachment} is ${size} bytes, over Discord's ${ATTACHMENT_LIMIT}. Announcing without it.`);
    } else {
        files.push({ name: basename(attachment), data: readFileSync(attachment) });
    }
}

await postRelease(webhookUrl, payload, fetch, files);
console.log(`discord-release: announced ${payload.embeds[0].title}`);
