// Renders element trees to HTML: escaped by default, async components awaited, and `<Suspense>`
// boundaries streamed after the shell when rendering to a stream.
import { Fragment, type Child, type ClassValue, type Component, type JSXElement, type RawHtml, type StyleValue } from './types';

const RAW = Symbol.for('@kivinjs/jsx raw');
const PROVIDER = Symbol.for('@kivinjs/jsx provider');
const SUSPENSE = Symbol.for('@kivinjs/jsx suspense');

/** Writes `html` without escaping. Only for trusted markup: anything user-controlled must not reach it. */
export function raw(html: string): RawHtml {
  return { [RAW]: true, html } as unknown as RawHtml;
}

/**
 * `value` as JSON that is safe inside `<script type="application/json">` (or a JS expression): `<`,
 * `>`, `&` and line separators are written as `\u` escapes, so the data cannot close the script.
 */
export function jsonScript(value: unknown): RawHtml {
  const json = JSON.stringify(value) ?? 'null';
  return raw(json.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

function isRaw(value: unknown): value is RawHtml {
  return typeof value === 'object' && value !== null && RAW in value;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

// ---- context ----

export interface JsxContext<T> {
  readonly defaultValue: T;
  /** `<Context.Provider value={...}>`: components below read `value` with `useContext`. */
  readonly Provider: Component<{ value: T; children?: Child }>;
}

let currentContexts: ReadonlyMap<JsxContext<unknown>, unknown> | undefined;

/** A value passed down the tree without props (`useContext` reads it). */
export function createContext<T>(defaultValue: T): JsxContext<T> {
  const context = { defaultValue } as { defaultValue: T; Provider: Component<{ value: T; children?: Child }> };
  const Provider = ((props: { children?: Child }) => props.children ?? null) as Component<{ value: T; children?: Child }>;
  Object.defineProperty(Provider, PROVIDER, { value: context });
  context.Provider = Provider;
  return context;
}

/**
 * The nearest provided value of `context`. Call it while a component runs (in an async component,
 * before its first `await`).
 */
export function useContext<T>(context: JsxContext<T>): T {
  if (!currentContexts) {
    throw new Error('@kivinjs/jsx: useContext() must be called while a component renders (in an async component, before its first await)');
  }
  return currentContexts.has(context as JsxContext<unknown>) ? (currentContexts.get(context as JsxContext<unknown>) as T) : context.defaultValue;
}

// ---- Suspense ----

/**
 * Streams `children` after the rest of the page: the stream first sends `fallback`, then the content
 * with a small inline script that swaps it in. Rendering to a string just awaits `children`.
 */
export const Suspense: Component<{ fallback?: Child; children?: Child }> = Object.defineProperty(
  (props: { children?: Child }) => props.children ?? null,
  SUSPENSE,
  { value: true },
) as Component<{ fallback?: Child; children?: Child }>;

// ---- rendering ----

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG_NAME = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9-]*)?$/;
// Anything a parser would read as the end of the name, a value or the tag (HTML attribute-name state).
const ATTRIBUTE_NAME = /^[^\s"'<>/=\u0000-\u001f\u007f]+$/;

interface RenderState {
  readonly stream: boolean;
  readonly nonce: string | undefined;
  nextId: number;
  readonly pending: Set<Promise<string>>;
}

function classString(value: ClassValue): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => classString(item as ClassValue)).filter(Boolean).join(' ');
  }
  return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ');
}

function styleString(value: StyleValue): string {
  if (typeof value === 'string') {
    return value;
  }
  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && item !== '')
    .map(([name, item]) => `${name.startsWith('--') ? name : name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}:${item}`)
    .join(';');
}

function attributes(props: Record<string, unknown>): string {
  let text = '';
  let classes: string[] | undefined;
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML' || key === 'key' || typeof value === 'function' || value === null || value === undefined) {
      continue;
    }
    if (key === 'class' || key === 'className') {
      (classes ??= []).push(classString(value as ClassValue));
      continue;
    }
    const name = key === 'htmlFor' ? 'for' : key;
    if (!ATTRIBUTE_NAME.test(name)) {
      throw new TypeError(`@kivinjs/jsx: invalid attribute name ${JSON.stringify(name)}`);
    }
    if (typeof value === 'boolean') {
      // ARIA / data-* values are the strings "true" / "false"; other booleans are presence attributes.
      if (name.startsWith('aria-') || name.startsWith('data-')) {
        text += ` ${name}="${value}"`;
      } else if (value) {
        text += ` ${name}`;
      }
      continue;
    }
    const written = name === 'style' && typeof value === 'object' ? styleString(value as StyleValue) : String(value);
    text += ` ${name}="${escapeHtml(written)}"`;
  }
  if (classes) {
    const joined = classes.filter(Boolean).join(' ');
    if (joined) {
      text = ` class="${escapeHtml(joined)}"${text}`;
    }
  }
  return text;
}

function swapScript(id: number, nonce: string | undefined) {
  const nonceAttribute = nonce === undefined ? '' : ` nonce="${escapeHtml(nonce)}"`;
  return `<script${nonceAttribute}>((i)=>{const t=document.querySelector('template[data-ks="'+i+'"]'),s=document.getElementById('ks:'+i);if(t&&s){let n=s.nextSibling;while(n&&!(n.nodeType===8&&n.data==='/ks:'+i)){const x=n.nextSibling;n.remove();n=x}n&&n.remove();s.replaceWith(t.content);t.remove()}document.currentScript.remove()})(${id})</script>`;
}

async function renderChildren(children: readonly Child[], contexts: ReadonlyMap<JsxContext<unknown>, unknown>, state: RenderState): Promise<string> {
  const parts = await Promise.all(children.map((child) => renderNode(child, contexts, state)));
  return parts.join('');
}

async function renderComponent(element: JSXElement, type: Component<any>, contexts: ReadonlyMap<JsxContext<unknown>, unknown>, state: RenderState): Promise<string> {
  const provided = (type as unknown as Record<symbol, JsxContext<unknown> | undefined>)[PROVIDER];
  if (provided) {
    const next = new Map(contexts);
    next.set(provided, element.props.value);
    return renderNode(element.props.children as Child, next, state);
  }
  if ((type as unknown as Record<symbol, unknown>)[SUSPENSE] && state.stream) {
    const id = state.nextId++;
    const content = renderNode(element.props.children as Child, contexts, state).then(
      (html) => `<template data-ks="${id}">${html}</template>${swapScript(id, state.nonce)}`,
      (error: unknown) => {
        // The page is already on its way: keep the fallback and log.
        console.error('[kivin] Suspense boundary failed', error);
        return '';
      },
    );
    state.pending.add(content);
    const fallback = await renderNode(element.props.fallback as Child, contexts, state);
    return `<template id="ks:${id}"></template>${fallback}<!--/ks:${id}-->`;
  }
  const previous = currentContexts;
  currentContexts = contexts;
  let result: Child | Promise<Child>;
  try {
    result = type(element.props);
  } finally {
    currentContexts = previous;
  }
  return renderNode(await result, contexts, state);
}

async function renderNode(node: Child, contexts: ReadonlyMap<JsxContext<unknown>, unknown>, state: RenderState): Promise<string> {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string') {
    return escapeHtml(node);
  }
  if (typeof node === 'number' || typeof node === 'bigint') {
    return String(node);
  }
  if (node instanceof Promise) {
    return renderNode((await (node as Promise<unknown>)) as Child, contexts, state);
  }
  if (Array.isArray(node)) {
    return renderChildren(node, contexts, state);
  }
  if (isRaw(node)) {
    return node.html;
  }
  const element = node as JSXElement;
  const { type, props } = element;
  if (type === Fragment) {
    return renderNode(props.children as Child, contexts, state);
  }
  if (typeof type === 'function') {
    return renderComponent(element, type, contexts, state);
  }
  if (typeof type !== 'string' || !TAG_NAME.test(type)) {
    throw new TypeError(`@kivinjs/jsx: invalid element type ${JSON.stringify(String(type))}`);
  }
  const open = `<${type}${attributes(props)}>`;
  if (VOID_ELEMENTS.has(type)) {
    return open;
  }
  const inner = props.dangerouslySetInnerHTML as { __html?: unknown } | undefined;
  const content = inner ? String(inner.__html ?? '') : await renderNode(props.children as Child, contexts, state);
  return `${open}${content}</${type}>`;
}

const EMPTY_CONTEXTS: ReadonlyMap<JsxContext<unknown>, unknown> = new Map();

/** The HTML of `node`, after every async component resolved. `<Suspense>` waits for its children. */
export function renderToString(node: Child): Promise<string> {
  return renderNode(node, EMPTY_CONTEXTS, { stream: false, nonce: undefined, nextId: 0, pending: new Set() });
}

export interface StreamOptions {
  /** CSP nonce for the inline scripts that swap `<Suspense>` content in. */
  nonce?: string;
  /** Written before the shell, e.g. `<!DOCTYPE html>`. */
  prefix?: string;
}

/**
 * A stream of `node`'s HTML: the shell (everything outside `<Suspense>` boundaries) first, then each
 * boundary's content as it resolves. Resolves once the shell rendered, so an error there still
 * rejects before any byte is sent.
 */
export async function renderToReadableStream(node: Child, options: StreamOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const state: RenderState = { stream: true, nonce: options.nonce, nextId: 0, pending: new Set() };
  const shell = await renderNode(node, EMPTY_CONTEXTS, state);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode((options.prefix ?? '') + shell));
      if (state.pending.size === 0) {
        controller.close();
      }
    },
    async pull(controller) {
      const [settled, html] = await Promise.race([...state.pending].map((pending) => pending.then((value) => [pending, value] as const)));
      state.pending.delete(settled);
      if (html) {
        controller.enqueue(encoder.encode(html));
      }
      if (state.pending.size === 0) {
        controller.close();
      }
    },
  });
}
