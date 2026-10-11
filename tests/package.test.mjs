import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import resourceUrls, { normalizeResourceUrls } from '../dist/index.js';
import { createResourceManifest, encodeResourceUrl, filePathToUrl } from '../dist/url.js';

test('compiled ESM exports work in Node without a TypeScript loader', () => {
  assert.equal(filePathToUrl('/file%40.png'), '/file%2540.png');
  assert.equal(encodeResourceUrl('/file%40.png'), '/file%40.png');
  assert.equal(createResourceManifest(['/file%40.png']).get('/file%40.png'), '/file%2540.png');
  assert.equal(resourceUrls().name, 'astro-cloudflare-resource-urls');
  assert.equal(typeof normalizeResourceUrls, 'function');
});
