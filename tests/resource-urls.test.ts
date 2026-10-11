import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createResourceManifest, encodeResourceUrl, filePathToUrl } from '../src/url.js';
import { normalizeResourceUrls, resourceUrlHandlers } from '../src/integration.js';

async function fixture(entries: Record<string, string>, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-urls-'));
  try {
    for (const [file, content] of Object.entries(entries)) {
      await mkdir(join(directory, file, '..'), { recursive: true });
      await writeFile(join(directory, file), content);
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('raw filenames and ready URLs have distinct percent semantics', () => {
  assert.equal(filePathToUrl('/image@2x.png'), '/image%402x.png');
  assert.equal(filePathToUrl('/image%402x.png'), '/image%25402x.png');
  assert.equal(filePathToUrl('/image%25402x.png'), '/image%2525402x.png');
  assert.equal(filePathToUrl('/a?b#c.png'), '/a%3Fb%23c.png');
  assert.equal(filePathToUrl('/a%2Fb.png'), '/a%252Fb.png');
  assert.equal(encodeResourceUrl('/image%402x.png'), '/image%402x.png');
  assert.equal(encodeResourceUrl('/image%25402x.png'), '/image%25402x.png');
  const manifest = createResourceManifest(['/image@2x.png', '/image%402x.png']);
  assert.equal(manifest.get('/image@2x.png'), '/image%402x.png');
  assert.equal(manifest.get('/image%402x.png'), '/image%25402x.png');
});

test('both @ and literal %40 files keep their identities across HTML, CSS and JS', async () => {
  const manifest = createResourceManifest([
    'images/a@2x.png',
    'images/a%402x.png',
    'images/a?b#c.png',
  ]);
  const at = `/${manifest.get('images/a@2x.png')}`;
  const percent = `/${manifest.get('images/a%402x.png')}`;
  const reserved = `/${manifest.get('images/a?b#c.png')}`;
  await fixture(
    {
      'images/a@2x.png': 'at-image',
      'images/a%402x.png': 'percent-image',
      'images/a?b#c.png': 'reserved-image',
      'pages%40/index.html': `<img src="../images/a@2x.png"><img src="${percent}"><img src="${reserved}"><script>const at='${at}', percent='${percent}';</script>`,
      'styles%40/main.css':
        'a{background:url(../images/a@2x.png)}b{background:url(../images/a%402x.png)}c{background:url(../images/a%25402x.png)}',
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory), 2);
      const html = await readFile(join(directory, 'pages%40/index.html'), 'utf8');
      assert.ok(html.includes('../images/a%402x.png'));
      assert.ok(html.includes(percent));
      assert.ok(html.includes(reserved));
      const css = await readFile(join(directory, 'styles%40/main.css'), 'utf8');
      assert.ok(css.includes('b{background:url(../images/a%402x.png)}'));
      assert.ok(css.includes('c{background:url(../images/a%25402x.png)}'));
      assert.equal(await normalizeResourceUrls(directory), 0);
    },
  );
});

test('rehashing literal %40 asset names encodes raw replacement filenames', async () => {
  await fixture(
    {
      'a@2x.png': 'image',
      'bundles/chunk%40.js': "export const image='/a@2x.png'",
      'index.html': '<script type="module" src="/bundles/chunk%2540.js"></script>',
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, { assetsDirectory: 'bundles' }), 2);
      const [file] = await readdir(join(directory, 'bundles'));
      assert.ok(file.startsWith('chunk%40.urls-'));
      const html = await readFile(join(directory, 'index.html'), 'utf8');
      assert.ok(html.includes(`/bundles/${filePathToUrl(file)}`));
      assert.equal(await normalizeResourceUrls(directory, { assetsDirectory: 'bundles' }), 0);
    },
  );
});

test('path segments match Cloudflare encoding without damaging URL syntax or double encoding', () => {
  const cases = {
    '/a@2x.png?q=a@b#x@y': '/a%402x.png?q=a@b#x@y',
    '/a%402x.png': '/a%402x.png',
    '/a%2fb.png': '/a%2Fb.png',
    '/тест/a b[2].png': '/%D1%82%D0%B5%D1%81%D1%82/a%20b%5B2%5D.png',
    '/100% done%20now.pdf': '/100%25%20done%20now.pdf',
    'https://jagk.dev/a@2x.png?next=/a@b': 'https://jagk.dev/a%402x.png?next=/a@b',
    '//jagk.dev/a@2x.png': '//jagk.dev/a%402x.png',
    'data:image/svg+xml,<svg>@</svg>': 'data:image/svg+xml,<svg>@</svg>',
    'mailto:me@example.com': 'mailto:me@example.com',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(encodeResourceUrl(input), expected);
    assert.equal(encodeResourceUrl(expected), expected);
  }
});

test('normalizes HTML, responsive candidates, model attributes and inline preload together', async () => {
  await fixture(
    {
      'images/a@1x.avif': 'image',
      'images/a@2x.avif': 'image',
      'index.html': `<p>me@example.com /images/a@1x.avif</p>
      <a href="https://other.dev/images/a@1x.avif">external</a>
      <a href="https://jagk.dev/images/a@1x.avif?q=@&amp;v=2#@">download</a>
      <picture><source srcset="/images/a@1x.avif 1x, /images/a@2x.avif 2x">
      <img src="/images/a%401x.avif"></picture>
      <link imagesrcset="/images/a@1x.avif 400w, /images/a@2x.avif 800w">
      <model poster="/images/a@1x.avif" environmentmap="/images/a@2x.avif"></model>
      <template><img src="/images/a@1x.avif"></template>
      <script>const srcset='/images/a@1x.avif 1x, /images/a@2x.avif 2x';
      const dynamic='/images/a@'+density+'.avif';</script>`,
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 1);
      const html = await readFile(join(directory, 'index.html'), 'utf8');
      assert.ok(html.includes('<p>me@example.com /images/a@1x.avif</p>'));
      assert.ok(html.includes('https://other.dev/images/a@1x.avif'));
      assert.ok(html.includes('https://jagk.dev/images/a%401x.avif?q=@&amp;v=2#@'));
      assert.ok(html.includes('/images/a%401x.avif 1x, /images/a%402x.avif 2x'));
      assert.ok(html.includes('/images/a%401x.avif 400w, /images/a%402x.avif 800w'));
      assert.ok(html.includes('poster="/images/a%401x.avif"'));
      assert.ok(html.includes('environmentmap="/images/a%402x.avif"'));
      assert.ok(html.includes('<template><img src="/images/a%401x.avif"></template>'));
      assert.ok(html.includes("const dynamic='/images/a@'+density+'.avif'"));
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 0);
    },
  );
});

test('handles CSS escapes, image-set, relative resources, JSON and literal percent filenames', async () => {
  await fixture(
    {
      'images/a@2x.png': 'image',
      'docs/100%.pdf': 'document',
      'css/main.css': `a{background:url('../images/a\\@2x.png?q=@#@');
      background-image:image-set("../images/a@2x.png" 2x);--image:url(../images/a@2x.png);content:"../images/a@2x.png"}`,
      'manifest.webmanifest': JSON.stringify({ icons: [{ src: '/images/a@2x.png' }] }),
      'index.html':
        '<a href="/docs/100%.pdf">100%</a><div style="background:url(/images/a@2x.png)"></div>',
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 3);
      const css = await readFile(join(directory, 'css/main.css'), 'utf8');
      assert.ok(css.includes('../images/a%402x.png?q=@#@'));
      assert.ok(css.includes('image-set("../images/a%402x.png" 2x)'));
      assert.ok(css.includes('--image:url(../images/a%402x.png)'));
      assert.ok(css.includes('content:"../images/a@2x.png"'));
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.webmanifest'), 'utf8'));
      assert.equal(manifest.icons[0].src, '/images/a%402x.png');
      assert.ok(
        (await readFile(join(directory, 'index.html'), 'utf8')).includes('/docs/100%25.pdf'),
      );
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 0);
    },
  );
});

test('respects HTML base URLs, and preserves foreign base URLs', async () => {
  await fixture(
    {
      'images/a@2x.png': 'image',
      'index.html': '<base href="/images/"><img src="a@2x.png">',
      'foreign.html': '<base href="https://other.dev/images/"><img src="a@2x.png">',
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 1);
      assert.equal(
        await readFile(join(directory, 'index.html'), 'utf8'),
        '<base href="/images/"><img src="a%402x.png">',
      );
      assert.equal(
        await readFile(join(directory, 'foreign.html'), 'utf8'),
        '<base href="https://other.dev/images/"><img src="a@2x.png">',
      );
    },
  );
});

test('rewrites SVG and XML resources without reserializing documents', async () => {
  await fixture(
    {
      'images/a@2x.png': 'image',
      'icon.svg':
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="/images/a@2x.png"/></svg>',
      'feed.xml':
        '<?xml version="1.0"?><rss><channel><enclosure url="/images/a@2x.png"/><link>https://jagk.dev/images/a@2x.png</link></channel></rss>',
    },
    async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 2);
      assert.equal(
        await readFile(join(directory, 'icon.svg'), 'utf8'),
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="/images/a%402x.png"/></svg>',
      );
      assert.ok(
        (await readFile(join(directory, 'feed.xml'), 'utf8')).includes(
          'https://jagk.dev/images/a%402x.png',
        ),
      );
    },
  );
});

test('preserves data URLs containing commas in srcset', async () => {
  await fixture(
    {
      'a@2x.png': 'image',
      'index.html': '<img srcset="data:image/png;base64,AAAA 1x, /a@2x.png 2x">',
    },
    async (directory) => {
      await normalizeResourceUrls(directory, 'https://jagk.dev');
      assert.equal(
        await readFile(join(directory, 'index.html'), 'utf8'),
        '<img srcset="data:image/png;base64,AAAA 1x, /a%402x.png 2x">',
      );
    },
  );
});

test('keeps escaped closing tags safe when rewriting inline JSON', async () => {
  await fixture(
    {
      'a@2x.png': 'image',
      'index.html':
        '<script type="application/ld+json">{"image":"/a@2x.png","text":"\\u003c/SCRIPT>"}</script>',
    },
    async (directory) => {
      await normalizeResourceUrls(directory, 'https://jagk.dev');
      const html = await readFile(join(directory, 'index.html'), 'utf8');
      assert.ok(html.includes('/a%402x.png'));
      assert.ok(html.includes('\\u003c/SCRIPT>'));
      assert.ok(!html.includes('</SCRIPT>'));
    },
  );
});

test('updates immutable asset names and transitive/cyclic references deterministically', async () => {
  const entries = {
    'a@2x.png': 'image',
    '_astro/main.ABC.js': `import './dep.XYZ.js';export const image='/a@2x.png';`,
    '_astro/dep.XYZ.js': `import './main.ABC.js';export const message='hello';`,
    '_astro/main.ABC.css': 'a{background:url(/a@2x.png)}',
    'index.html':
      '<script type="module" src="/_astro/main.ABC.js" integrity="sha384-old"></script><link href="/_astro/main.ABC.css">',
  };
  let firstHtml = '';
  for (let repeat = 0; repeat < 2; repeat++) {
    await fixture(entries, async (directory) => {
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 4);
      const files = await readdir(join(directory, '_astro'));
      assert.equal(files.length, 3);
      assert.ok(files.every((file) => file.includes('.urls-')));
      const main = files.find((file) => file.startsWith('main.ABC') && file.endsWith('.js'))!;
      const dep = files.find((file) => file.startsWith('dep.XYZ'))!;
      assert.ok((await readFile(join(directory, '_astro', main), 'utf8')).includes(dep));
      assert.ok((await readFile(join(directory, '_astro', dep), 'utf8')).includes(main));
      const html = await readFile(join(directory, 'index.html'), 'utf8');
      assert.ok(html.includes(main));
      const integrity = createHash('sha384')
        .update(await readFile(join(directory, '_astro', main)))
        .digest('base64');
      assert.ok(html.includes(`integrity="sha384-${integrity}"`));
      if (repeat) assert.equal(html, firstHtml);
      firstHtml = html;
      assert.equal(await normalizeResourceUrls(directory, 'https://jagk.dev'), 0);
    });
  }
});

test('extension handlers add formats, override built-ins and disable processing', async () => {
  await fixture(
    {
      'image@2x.png': 'image',
      'entry.cjs': "return require('./image@2x.png');",
      'data.json': '{"label":"/image@2x.png"}',
      'entry.custom': '/image@2x.png',
      'entry.txt': '/image@2x.png',
      'module.extra': 'export default "/image@2x.png";',
    },
    async (directory) => {
      const seen = new Set<string>();
      const options = {
        handlers: {
          '.json': false as const,
          '.custom': (
            source: string,
            { file, rewrite }: import('../src/integration.js').ResourceUrlHandlerContext,
          ) => {
            seen.add(file);
            return rewrite(source);
          },
          '.extra': resourceUrlHandlers.javascript,
        },
      };
      assert.equal(await normalizeResourceUrls(directory, options), 3);
      assert.equal(
        await readFile(join(directory, 'entry.cjs'), 'utf8'),
        'return require("./image%402x.png");',
      );
      assert.equal(await readFile(join(directory, 'entry.custom'), 'utf8'), '/image%402x.png');
      assert.equal(
        await readFile(join(directory, 'module.extra'), 'utf8'),
        'export default "/image%402x.png";',
      );
      assert.equal(await readFile(join(directory, 'entry.txt'), 'utf8'), '/image@2x.png');
      assert.equal(
        await readFile(join(directory, 'data.json'), 'utf8'),
        '{"label":"/image@2x.png"}',
      );
      assert.deepEqual([...seen], ['entry.custom']);
      assert.equal(await normalizeResourceUrls(directory, options), 0);
      await normalizeResourceUrls(directory, {
        handlers: { '.json': (source) => source.replace('label', 'description') },
      });
      assert.equal(
        await readFile(join(directory, 'data.json'), 'utf8'),
        '{"description":"/image@2x.png"}',
      );
    },
  );
});

test('custom handlers participate in immutable renaming and dependency propagation', async () => {
  await fixture(
    {
      'image@2x.png': 'image',
      '_astro/entry.refs': '/image@2x.png',
      'index.html': '<a href="/_astro/entry.refs">download</a>',
    },
    async (directory) => {
      const options = {
        handlers: {
          '.refs': (
            source: string,
            { rewrite }: import('../src/integration.js').ResourceUrlHandlerContext,
          ) => rewrite(source),
        },
      };
      assert.equal(await normalizeResourceUrls(directory, options), 2);
      const [asset] = await readdir(join(directory, '_astro'));
      assert.match(asset, /^entry\.urls-[a-f0-9]+\.refs$/);
      assert.equal(await readFile(join(directory, '_astro', asset), 'utf8'), '/image%402x.png');
      assert.ok(
        (await readFile(join(directory, 'index.html'), 'utf8')).includes(`/_astro/${asset}`),
      );
      assert.equal(await normalizeResourceUrls(directory, options), 0);
    },
  );
});
