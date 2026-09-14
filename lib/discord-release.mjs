const DESCRIPTION_LIMIT = 4096;
const NOTES_BUDGET = 3800;

function trimNotes(notes, releaseUrl) {
    const text = notes.trim();
    if (text.length <= NOTES_BUDGET) {
        return text;
    }

    const cut = text.slice(0, NOTES_BUDGET);
    const lastBreak = cut.lastIndexOf('\n');
    const kept = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd();

    return `${kept}\n\n[Read the full changelog](${releaseUrl})`;
}

/**
 * Builds the Discord webhook body for one mod release.
 */
function workshopField(spec) {
    const items = (Array.isArray(spec) ? spec : String(spec).split(',')).map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) {
        return null;
    }

    const links = items.map((item) => {
        const [label, id] = item.includes('=') ? item.split('=').map((part) => part.trim()) : ['Workshop page', item];
        return `[${label}](https://steamcommunity.com/sharedfiles/filedetails/?id=${id})`;
    });

    return { name: 'Steam Workshop', value: links.join('\n'), inline: true };
}

export function buildReleasePayload({ modName, tag, releaseUrl, workshopId, roleIds = [], notes = '', color = 0x5865f2, timestamp }) {
    const roles = (Array.isArray(roleIds) ? roleIds : String(roleIds).split(',')).map((id) => id.trim()).filter(Boolean);
    for (const [key, value] of Object.entries({ modName, tag, releaseUrl })) {
        if (!value) {
            throw new Error(`discord-release: ${key} is required`);
        }
    }

    const fields = [{ name: 'GitHub release', value: `[Release notes](${releaseUrl})`, inline: true }];
    const workshop = workshopId ? workshopField(workshopId) : null;
    if (workshop) {
        fields.unshift(workshop);
    }

    const description = trimNotes(notes, releaseUrl);
    if (description.length > DESCRIPTION_LIMIT) {
        throw new Error('discord-release: description exceeded the embed limit');
    }

    return {
        content: roles.map((id) => `<@&${id}>`).join(' '),
        allowed_mentions: { parse: [], roles },
        embeds: [
            {
                title: `${modName} ${tag}`.slice(0, 256),
                url: releaseUrl,
                description,
                color,
                fields,
                timestamp: timestamp ?? new Date().toISOString(),
            },
        ],
    };
}

export async function postRelease(webhookUrl, payload, fetchImpl = fetch) {
    const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`discord-release: webhook returned ${response.status} ${await response.text()}`);
    }
}
