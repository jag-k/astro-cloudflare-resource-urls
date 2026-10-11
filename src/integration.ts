import { createHash } from 'node:crypto';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { parse as parseJs } from 'acorn';
import { ancestor } from 'acorn-walk';
import { generate, parse as parseCss, walk, type CssNode, type WalkContext } from 'css-tree';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import parseSrcset from 'parse-srcset';
import { createResourceManifest, encodeResourceUrl, filePathToUrl } from './url.js';

export interface ResourceUrlHandlerContext {
  /** Raw output path, relative to the build directory. */
  file: string;
  /** Rewrite a ready URL relative to the current file. Records asset dependencies. */
  rewrite: (url: string) => string;
  /** Resolve URLs against a document-specific base, such as HTML's <base>. */
  withBase: (base: string) => (url: string) => string;
}

/** A synchronous, deterministic text transformation, possibly called more than once. */
export type ResourceUrlHandler = (source: string, context: ResourceUrlHandlerContext) => string;

export interface ResourceUrlsOptions {
  /** Same-origin absolute URLs to process. Defaults to Astro's site, if configured. */
  site?: string;
  /** Directory containing immutable build assets. Defaults to Astro's build.assets. */
  assetsDirectory?: string;
  /** Skip transforming a file's contents; the filename still participates in lookup. */
  exclude?: (file: string) => boolean;
  /** Add or override extension handlers; false disables a built-in handler. Keys include the dot. */
  handlers?: Readonly<Record<string, ResourceUrlHandler | false>>;
}

type Rewrite = (url: string) => string;
type Edit = { start: number; end: number; value: string };

function applyEdits(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  }
  return source;
}

function rewriteSrcset(value: string, rewrite: Rewrite): string {
  const candidates = parseSrcset(value);
  if (!candidates.some((candidate) => rewrite(candidate.url) !== candidate.url)) return value;
  return candidates
    .map(({ url, w, h, d }) =>
      [rewrite(url), w && `${w}w`, h && `${h}h`, d && `${d}x`].filter(Boolean).join(' '),
    )
    .join(', ');
}

function rewriteCss(source: string, rewrite: Rewrite, context = 'stylesheet'): string {
  const edits: Edit[] = [];
  const tree = parseCss(source, { positions: true, context, parseCustomProperty: true });
  walk(tree, {
    enter(this: WalkContext, node: CssNode) {
      if ((node.type !== 'Url' && node.type !== 'String') || !node.loc) return;
      // Quoted URLs occur in @import and image-set; other CSS strings are text.
      if (
        node.type === 'String' &&
        !['image-set', '-webkit-image-set'].includes(this.function?.name || '') &&
        !(this.atrule?.name === 'import' && this.atrulePrelude)
      )
        return;
      const value = rewrite(node.value);
      if (value === node.value) return;
      edits.push({
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        value: generate({ ...node, value }),
      });
    },
  });
  return applyEdits(source, edits);
}

function rewriteJs(source: string, rewrite: Rewrite, module = true): string {
  const edits: Edit[] = [];
  const tree = parseJs(source, {
    ecmaVersion: 'latest',
    sourceType: module ? 'module' : 'script',
    allowReturnOutsideFunction: !module,
  });
  const rewriteString = (value: string) => {
    const url = rewrite(value);
    if (url !== value) return url;
    return /\s\d+(?:\.\d+)?[wxh](?:\s*,|\s*$)/.test(value) ? rewriteSrcset(value, rewrite) : value;
  };
  ancestor(tree, {
    Literal(node, _state, ancestors) {
      const parent = ancestors.at(-2);
      if (parent?.type === 'Property' && parent.key === node) return;
      if (typeof node.value !== 'string') return;
      const value = rewriteString(node.value);
      if (value !== node.value) {
        edits.push({
          start: node.start,
          end: node.end,
          value: JSON.stringify(value).replaceAll('<', '\\u003c'),
        });
      }
    },
    TemplateLiteral(node) {
      // Expressions cannot be resolved reliably at build time. Fully static
      // templates are safe; dynamic URLs must use encodeResourceUrl explicitly.
      if (node.expressions.length || node.quasis[0].value.cooked == null) return;
      const original = node.quasis[0].value.cooked;
      const value = rewriteString(original);
      if (value !== original) {
        edits.push({
          start: node.start,
          end: node.end,
          value: JSON.stringify(value).replaceAll('<', '\\u003c'),
        });
      }
    },
  });
  return applyEdits(source, edits);
}

const urlAttributes = new Set([
  'src',
  'href',
  'xlink:href',
  'poster',
  'data',
  'action',
  'formaction',
  'cite',
  'background',
  'longdesc',
  'manifest',
  'environmentmap',
  'url',
]);

function rewriteHtml(
  source: string,
  rewrite: Rewrite,
  withBase: (base: string) => Rewrite,
  xml = false,
  integrity?: (url: string, hash: string, base?: string) => string,
): string {
  const edits: Edit[] = [];
  const tree = parseHtml(source, { sourceCodeLocationInfo: true });
  function findBase(node: DefaultTreeAdapterMap['node']): string | undefined {
    if ('tagName' in node && node.tagName === 'base') {
      return node.attrs.find((attribute) => attribute.name === 'href')?.value;
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) {
        const base = findBase(child);
        if (base !== undefined) return base;
      }
    }
  }
  const base = findBase(tree);
  if (base !== undefined) rewrite = withBase(base);
  function visit(node: DefaultTreeAdapterMap['node']) {
    if (xml && node.nodeName === '#text' && 'value' in node && node.sourceCodeLocation) {
      const value = rewrite(node.value);
      if (value !== node.value)
        edits.push({
          start: node.sourceCodeLocation.startOffset,
          end: node.sourceCodeLocation.endOffset,
          value: value.replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
        });
    }
    if ('tagName' in node) {
      for (const attribute of node.attrs) {
        const name = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
        let value = attribute.value;
        if (urlAttributes.has(name) || (node.tagName === 'meta' && name === 'content')) {
          value = rewrite(value);
        } else if (name === 'srcset' || name === 'imagesrcset') {
          value = rewriteSrcset(value, rewrite);
        } else if (name === 'style') {
          value = rewriteCss(value, rewrite, 'declarationList');
        } else if (['fill', 'stroke', 'filter', 'clip-path', 'mask'].includes(name)) {
          value = rewriteCss(value, rewrite, 'value');
        } else if (name === 'ping') {
          value = value.split(/\s+/).map(rewrite).join(' ');
        } else if (name === 'integrity' && integrity) {
          const url = node.attrs.find((attr) => attr.name === 'src' || attr.name === 'href')?.value;
          if (url) value = integrity(url, value, base);
        }
        const location = node.sourceCodeLocation?.attrs?.[name];
        if (value === attribute.value || !location) continue;
        // Patch source ranges, preserving all unrelated markup, scripts and XML.
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          value: `${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`,
        });
      }
      const location = node.sourceCodeLocation;
      if (location?.startTag && location.endTag) {
        const start = location.startTag.endOffset;
        const end = location.endTag.startOffset;
        const original = source.slice(start, end);
        let value = original;
        if (node.tagName === 'style') value = rewriteCss(original, rewrite);
        if (node.tagName === 'script') {
          const type = node.attrs.find((attr) => attr.name === 'type')?.value || '';
          if (type.includes('json')) {
            value = rewriteJson(original, rewrite);
            if (value !== original) value = value.replaceAll('<', '\\u003c');
          } else if (['', 'module', 'text/javascript', 'application/javascript'].includes(type)) {
            value = rewriteJs(original, rewrite, type === 'module').replaceAll(
              '</script',
              '<\\/script',
            );
          }
        }
        if (value !== original) edits.push({ start, end, value });
      }
      if ('content' in node) visit(node.content);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(tree);
  return applyEdits(source, edits);
}

function rewriteJson(source: string, rewrite: Rewrite): string {
  let changed = false;
  const value: unknown = JSON.parse(source, (_key, value: unknown) => {
    if (typeof value !== 'string') return value;
    const result = rewrite(value);
    changed ||= result !== value;
    return result;
  });
  return changed ? JSON.stringify(value) : source;
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(posix.join(directory, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = posix.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(directory, path) : [path];
    }),
  );
  return files.flat();
}

/** Reusable parsers for registering additional extensions. */
export const resourceUrlHandlers = Object.freeze({
  html: ((source, { rewrite, withBase }) =>
    rewriteHtml(source, rewrite, withBase)) as ResourceUrlHandler,
  css: ((source, { rewrite }) => rewriteCss(source, rewrite)) as ResourceUrlHandler,
  javascript: ((source, { rewrite }) => rewriteJs(source, rewrite)) as ResourceUrlHandler,
  commonjs: ((source, { rewrite }) => rewriteJs(source, rewrite, false)) as ResourceUrlHandler,
  json: ((source, { rewrite }) => rewriteJson(source, rewrite)) as ResourceUrlHandler,
  svg: ((source, { rewrite, withBase }) =>
    rewriteHtml(source, rewrite, withBase)) as ResourceUrlHandler,
  xml: ((source, { rewrite, withBase }) =>
    rewriteHtml(source, rewrite, withBase, true)) as ResourceUrlHandler,
});

const defaultHandlers: Readonly<Record<string, ResourceUrlHandler>> = Object.freeze({
  '.html': resourceUrlHandlers.html,
  '.css': resourceUrlHandlers.css,
  '.js': resourceUrlHandlers.javascript,
  '.mjs': resourceUrlHandlers.javascript,
  '.cjs': resourceUrlHandlers.commonjs,
  '.json': resourceUrlHandlers.json,
  '.webmanifest': resourceUrlHandlers.json,
  '.svg': resourceUrlHandlers.svg,
  '.xml': resourceUrlHandlers.xml,
});

/** Process the shared build artifact, after compression, for every deployment. */
export async function normalizeResourceUrls(
  directory: string,
  options: ResourceUrlsOptions | string = {},
): Promise<number> {
  const settings = typeof options === 'string' ? { site: options } : options;
  const handlers = { ...defaultHandlers, ...settings.handlers };
  for (const extension of Object.keys(handlers)) {
    if (!/^\.[^./\\]+$/.test(extension))
      throw new Error(`Resource handler extension must include a leading dot: ${extension}`);
  }
  const files = new Set(await listFiles(directory));
  const manifest = createResourceManifest(files);
  const origin = new URL(settings.site || 'https://resource-urls.invalid').origin;
  const assetsPrefix = `${(settings.assetsDirectory || '_astro').replace(/^\/+|\/+$/g, '')}/`;
  const isImmutable = (file: string) => file.startsWith(assetsPrefix);
  const sources = new Map<string, string>();
  for (const file of files) {
    if (handlers[posix.extname(file)] && !settings.exclude?.(file)) {
      sources.set(file, await readFile(posix.join(directory, file), 'utf8'));
    }
  }
  const dependencies = new Map<string, Set<string>>();
  const renamed = new Map<string, string>();
  function resolver(file: string, baseHref?: string): Rewrite {
    const documentUrl = new URL(`/${manifest.get(file)!}`, origin);
    const base = baseHref === undefined ? documentUrl : new URL(baseHref, documentUrl);
    return (value) => {
      // Do not reinterpret ordinary prose, fragments, data URLs or foreign URLs.
      if (!value || value.trim() !== value || value.startsWith('#')) return value;
      let url: URL;
      try {
        url = new URL(value, base);
      } catch {
        return value;
      }
      if (url.origin !== origin) return value;
      let target: string;
      try {
        target = decodeURIComponent(url.pathname.replace(/%(?![\da-f]{2})/gi, '%25')).slice(1);
      } catch {
        return value;
      }
      if (!files.has(target)) return value;
      dependencies.get(file)?.add(target);
      const replacement = renamed.get(target);
      // Keep absolute/root-relative/relative URL shape, query and fragment.
      const match = /^(?:[a-z][a-z\d+.-]*:\/\/[^/]+|\/\/[^/]+)?([^?#]*)([\s\S]*)$/i.exec(value);
      if (!match) return value;
      const pathname = match[1];
      let path = pathname;
      if (replacement) {
        path = pathname.startsWith('/')
          ? `/${replacement}`
          : posix.relative(decodeURIComponent(new URL('.', base).pathname).slice(1), replacement);
        if (pathname.startsWith('./')) path = `./${path}`;
      }
      const start = value.length - pathname.length - match[2].length;
      return (
        value.slice(0, start) +
        (replacement ? filePathToUrl(path) : encodeResourceUrl(path)) +
        match[2]
      );
    };
  }
  function transform(file: string, source: string): string {
    const handler = handlers[posix.extname(file)];
    if (!handler) return source;
    return handler(source, {
      file,
      rewrite: resolver(file),
      withBase: (base) => resolver(file, base),
    });
  }
  const initial = new Map<string, string>();
  const affected = new Set<string>();
  for (const [file, source] of sources) {
    dependencies.set(file, new Set());
    const result = transform(file, source);
    initial.set(file, result);
    if (result !== source) affected.add(file);
  }
  // Propagate through references before changing immutable asset names. A shared
  // fingerprint also handles cyclic module graphs without iterative rehashing.
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const [file, targets] of dependencies) {
      if (
        !affected.has(file) &&
        [...targets].some((target) => affected.has(target) && isImmutable(target))
      ) {
        affected.add(file);
        propagated = true;
      }
    }
  }
  const fingerprint = createHash('sha256');
  for (const file of [...affected].sort())
    fingerprint.update(JSON.stringify([file, initial.get(file)]));
  const digest = fingerprint.digest('hex').slice(0, 16);
  for (const file of affected) {
    if (!isImmutable(file)) continue;
    if (files.has(`${file}.map`))
      throw new Error(`URL normalization needs source-map support: ${file}`);
    const extension = posix.extname(file);
    renamed.set(file, `${file.slice(0, -extension.length)}.urls-${digest}${extension}`);
  }
  const output = new Map<string, string>();
  for (const [file, source] of sources) {
    const result = transform(file, source);
    if (result === source && !renamed.has(file)) continue;
    output.set(renamed.get(file) || file, result);
  }
  // Rehashed scripts/styles must retain valid Subresource Integrity attributes.
  for (const [file, source] of sources) {
    if (handlers[posix.extname(file)] !== resourceUrlHandlers.html) continue;
    const path = renamed.get(file) || file;
    const html = output.get(path) || source;
    const result = rewriteHtml(
      html,
      (url) => url,
      () => (url) => url,
      false,
      (value, hash, baseHref) => {
        const documentUrl = new URL(`/${manifest.get(file)!}`, origin);
        const base = baseHref === undefined ? documentUrl : new URL(baseHref, documentUrl);
        const url = new URL(value, base);
        if (url.origin !== origin) return hash;
        const content = output.get(decodeURIComponent(url.pathname).slice(1));
        if (content === undefined) return hash;
        return hash
          .split(/\s+/)
          .map((token) => {
            const match = /^(sha(?:256|384|512))-[^?]+(.*)$/.exec(token);
            return match
              ? `${match[1]}-${createHash(match[1]).update(content).digest('base64')}${match[2]}`
              : token;
          })
          .join(' ');
      },
    );
    if (result !== html) output.set(path, result);
  }
  for (const [file, content] of output) await writeFile(posix.join(directory, file), content);
  for (const file of renamed.keys()) await unlink(posix.join(directory, file));
  return output.size;
}

export default function resourceUrls(options: ResourceUrlsOptions = {}): AstroIntegration {
  let settings: ResourceUrlsOptions = options;
  return {
    name: 'astro-cloudflare-resource-urls',
    hooks: {
      'astro:config:done': ({ config }) => {
        settings = {
          ...options,
          site: options.site ?? config.site,
          assetsDirectory: options.assetsDirectory ?? config.build.assets,
        };
      },
      'astro:build:done': async ({ dir, logger }) => {
        const count = await normalizeResourceUrls(fileURLToPath(dir), settings);
        logger.info(`Normalized resource URLs in ${count} files`);
      },
    },
  };
}
