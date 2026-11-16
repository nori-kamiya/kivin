// Static site generation (Hono's `ssg`): calls the app for every GET route of the manifest and writes
// the responses to files that `@kivinjs/static` (or any static host) serves as is.
import type { AppManifest } from '@kivinjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

/** Values for a route's path params: a list, or a function returning one (e.g. from a database). */
export type StaticParamsSource = readonly Record<string, string>[] | (() => readonly Record<string, string>[] | Promise<readonly Record<string, string>[]>);

// Written by `@StaticParams` on the controller's decorator metadata; read here by symbol so it works
// whichever @kivinjs/* copies the app resolved.
const STATIC_PARAMS = Symbol.for('kivin.staticParams');
const METADATA = (Symbol as { metadata?: symbol }).metadata ?? Symbol.for('Symbol.metadata');

export interface StaticSiteOptions {
  /** The app (`createApp(...)`), already `init()`ed when it has startup hooks. */
  app: { fetch(request: Request): Response | Promise<Response> };
  manifest: Pick<AppManifest, 'routes'>;
  outDir: string;
  /** `directory` (default): `/about` → `about/index.html`. `file`: `/about` → `about.html`. */
  format?: 'directory' | 'file';
  /** Params per route path (`'/posts/:slug'`), in addition to / instead of `@StaticParams`. */
  params?: Record<string, StaticParamsSource>;
  /** Paths to leave out: exact route or page paths, patterns, or a predicate on the page path. */
  exclude?: readonly (string | RegExp)[] | ((path: string) => boolean);
  /** Origin of the requests made to the app. Default `http://localhost`. */
  origin?: string;
}

export interface StaticSiteResult {
  files: Array<{ path: string; file: string; contentType: string }>;
  warnings: string[];
}

const EXTENSIONS: Record<string, string> = {
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'application/rss+xml': '.xml',
  'application/atom+xml': '.xml',
  'application/manifest+json': '.webmanifest',
};

function staticParamsOf(route: AppManifest['routes'][number]): StaticParamsSource | undefined {
  const metadata = (route.controller as unknown as Record<symbol, Record<symbol, Record<string, StaticParamsSource>> | undefined>)[METADATA];
  return metadata?.[STATIC_PARAMS]?.[route.methodName];
}

function excluded(exclude: StaticSiteOptions['exclude'], routePath: string, pagePath: string) {
  if (!exclude) {
    return false;
  }
  if (typeof exclude === 'function') {
    return exclude(pagePath);
  }
  return exclude.some((rule) => (typeof rule === 'string' ? rule === routePath || rule === pagePath : rule.test(pagePath)));
}

function fill(routePath: string, params: Record<string, string>): string | undefined {
  let missing = false;
  const path = routePath.replace(/:([A-Za-z_$][\w$]*)|\*/g, (token, name: string | undefined) => {
    const value = params[name ?? '*'];
    if (value === undefined) {
      missing = true;
      return token;
    }
    // A wildcard may span segments; each segment is encoded so no value can climb out of outDir.
    return name === undefined ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
  });
  return missing ? undefined : path;
}

function fileFor(pagePath: string, contentType: string, format: 'directory' | 'file'): string | undefined {
  const segments = pagePath.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'))) {
    return undefined;
  }
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
  const last = segments.at(-1) ?? '';
  if (mediaType === 'text/html') {
    if (extname(last) === '.html') {
      return segments.join('/');
    }
    if (segments.length === 0) {
      return 'index.html';
    }
    return format === 'directory' ? [...segments, 'index.html'].join('/') : `${segments.join('/')}.html`;
  }
  if (extname(last)) {
    return segments.join('/');
  }
  const extension = EXTENSIONS[mediaType];
  return extension && segments.length > 0 ? `${segments.join('/')}${extension}` : undefined;
}

/**
 * Renders every GET route of `manifest` through `app` into `outDir`. Routes with path params need
 * their values (`@StaticParams` or `params`); routes without them are skipped with a warning, as are
 * non-2xx answers and content types without a known file extension.
 */
export async function generateStaticSite(options: StaticSiteOptions): Promise<StaticSiteResult> {
  const outDir = resolve(options.outDir);
  const format = options.format ?? 'directory';
  const origin = options.origin ?? 'http://localhost';
  const result: StaticSiteResult = { files: [], warnings: [] };
  const written = new Map<string, string>();

  for (const route of options.manifest.routes) {
    if (route.method !== 'GET') {
      continue;
    }
    const routePath = route.fullPath;
    const dynamic = /:|\*/.test(routePath);
    let pagePaths: string[];
    if (dynamic) {
      const source = options.params?.[routePath] ?? staticParamsOf(route);
      if (!source) {
        result.warnings.push(`${routePath}: skipped (path params without @StaticParams or the params option)`);
        continue;
      }
      const list = typeof source === 'function' ? await source() : source;
      pagePaths = [];
      for (const params of list) {
        const filled = fill(routePath, params);
        if (filled === undefined) {
          result.warnings.push(`${routePath}: skipped ${JSON.stringify(params)} (a path param is missing)`);
        } else {
          pagePaths.push(filled);
        }
      }
    } else {
      pagePaths = [routePath];
    }

    for (const pagePath of pagePaths) {
      if (excluded(options.exclude, routePath, pagePath)) {
        continue;
      }
      const response = await options.app.fetch(new Request(new URL(pagePath, origin)));
      if (response.status < 200 || response.status >= 300) {
        result.warnings.push(`${pagePath}: skipped (status ${response.status})`);
        await response.body?.cancel();
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      const file = fileFor(pagePath, contentType, format);
      const target = file === undefined ? undefined : resolve(outDir, file);
      if (!target || relative(outDir, target).startsWith(`..${sep}`) || relative(outDir, target) === '..') {
        result.warnings.push(`${pagePath}: skipped (no file name for "${contentType || 'no content type'}")`);
        await response.body?.cancel();
        continue;
      }
      const previous = written.get(target);
      if (previous) {
        result.warnings.push(`${pagePath}: skipped (${file} was already written for ${previous})`);
        await response.body?.cancel();
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(await response.arrayBuffer()));
      written.set(target, pagePath);
      result.files.push({ path: pagePath, file: file!, contentType });
    }
  }
  return result;
}
