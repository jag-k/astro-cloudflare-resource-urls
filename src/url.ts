/** Turn a raw URL-style file path into a URL path. Never decode filename characters. */
export function filePathToUrl(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Map exact raw filenames to their URL paths, preserving literal percent sequences. */
export function createResourceManifest(paths: Iterable<string>): ReadonlyMap<string, string> {
  return new Map(Array.from(paths, (path) => [path, filePathToUrl(path)]));
}

/** Normalize a ready URL. Percent escapes identify characters, not literal filename text. */
export function encodeResourceUrl(value: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return value;
  const match = /^((?:https?:)?\/\/[^/?#]+)?([^?#]*)([\s\S]*)$/i.exec(value)!;
  const pathname = match[2]
    .split('/')
    .map((segment) => {
      try {
        // Escape literal percent signs before decoding existing sequences once.
        return encodeURIComponent(decodeURIComponent(segment.replace(/%(?![\da-f]{2})/gi, '%25')));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
  return (match[1] || '') + pathname + match[3];
}
