import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleasePayload, postRelease } from '../lib/discord-release.mjs';

const base = {
    modName: 'Pickle',
    tag: 'v1.2.0',
    releaseUrl: 'https://github.com/RimWorks/Pickle/releases/tag/v1.2.0',
    workshopId: '3791648678',
    roleIds: '123',
    notes: '### Features\n\n* did a thing',
    timestamp: '2026-01-01T00:00:00.000Z',
};

test('pings only the mod role', () => {
    const payload = buildReleasePayload(base);

    assert.equal(payload.content, '<@&123>');
    assert.deepEqual(payload.allowed_mentions, { parse: [], roles: ['123'] });
});

test('pings every role a multi-mod release covers', () => {
    const payload = buildReleasePayload({ ...base, roleIds: '123, 456 ,789' });

    assert.equal(payload.content, '<@&123> <@&456> <@&789>');
    assert.deepEqual(payload.allowed_mentions.roles, ['123', '456', '789']);
});

test('announces with no ping when no role is given', () => {
    const payload = buildReleasePayload({ ...base, roleIds: '' });

    assert.equal(payload.content, '');
    assert.deepEqual(payload.allowed_mentions.roles, []);
});

test('links the workshop page and the release', () => {
    const [embed] = buildReleasePayload(base).embeds;

    assert.equal(embed.title, 'Pickle v1.2.0');
    assert.equal(embed.fields[0].value, '[Workshop page](https://steamcommunity.com/sharedfiles/filedetails/?id=3791648678)');
    assert.equal(embed.fields[1].value, `[Release notes](${base.releaseUrl})`);
});

test('lists every workshop item a multi-mod release ships', () => {
    const spec = 'Core=3474223604, Scadrial=3474236328, Roshar=3706867006';
    const [embed] = buildReleasePayload({ ...base, workshopId: spec }).embeds;

    assert.equal(
        embed.fields[0].value,
        [
            '[Core](https://steamcommunity.com/sharedfiles/filedetails/?id=3474223604)',
            '[Scadrial](https://steamcommunity.com/sharedfiles/filedetails/?id=3474236328)',
            '[Roshar](https://steamcommunity.com/sharedfiles/filedetails/?id=3706867006)',
        ].join('\n'),
    );
});

test('drops the workshop field when the mod has no item', () => {
    const [embed] = buildReleasePayload({ ...base, workshopId: undefined }).embeds;

    assert.equal(embed.fields.length, 1);
    assert.equal(embed.fields[0].name, 'GitHub release');
});

test('truncates long notes on a line break and links the rest', () => {
    const notes = Array.from({ length: 500 }, (_, i) => `* change number ${i}`).join('\n');
    const [embed] = buildReleasePayload({ ...base, notes }).embeds;

    assert.ok(embed.description.length < 4096);
    assert.ok(embed.description.endsWith(`[Read the full changelog](${base.releaseUrl})`));
    assert.ok(!embed.description.includes('change number 499'));
    assert.ok(embed.description.includes('* change number 0\n'));
});

test('announces a repo that cuts no GitHub release', () => {
    const [embed] = buildReleasePayload({ ...base, releaseUrl: '' }).embeds;

    assert.equal(embed.title, 'Pickle v1.2.0');
    assert.equal(embed.url, undefined);
    assert.equal(embed.fields.length, 1);
    assert.equal(embed.fields[0].name, 'Steam Workshop');
    assert.equal(embed.description, base.notes);
});

test('ends truncated notes with an ellipsis when there is no release to link', () => {
    const notes = Array.from({ length: 500 }, (_, i) => `* change number ${i}`).join('\n');
    const [embed] = buildReleasePayload({ ...base, releaseUrl: '', notes }).embeds;

    assert.ok(embed.description.length < 4096);
    assert.ok(embed.description.endsWith('...'));
});

test('rejects a release with no tag', () => {
    assert.throws(() => buildReleasePayload({ ...base, tag: '' }), /tag is required/);
});

test('throws on a failed webhook post', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });

    await assert.rejects(postRelease('https://example.invalid', {}, fetchImpl), /429 rate limited/);
});

test('uploads an attached zip alongside the embed', async () => {
    let request;
    const fetchImpl = async (_url, init) => {
        request = init;
        return { ok: true, status: 200, text: async () => '' };
    };

    const payload = buildReleasePayload(base);
    const files = [{ name: 'Pickle-1.2.0.zip', data: Buffer.from('zip bytes') }];
    await postRelease('https://example.invalid', payload, fetchImpl, files);

    assert.ok(request.body instanceof FormData);
    assert.equal(request.headers, undefined);
    assert.equal(request.body.get('files[0]').name, 'Pickle-1.2.0.zip');
    assert.deepEqual(JSON.parse(request.body.get('payload_json')).attachments, [{ id: 0, filename: 'Pickle-1.2.0.zip' }]);
});
