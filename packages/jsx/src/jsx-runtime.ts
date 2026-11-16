// The automatic JSX runtime (`"jsx": "react-jsx"`, `"jsxImportSource": "@kivinjs/jsx"`).
import { Fragment, type Child, type Component, type CustomElements, type IntrinsicElements as Elements, type JSXElement } from './types';

export { Fragment };

/** Builds an element; rendering happens later (`renderToString`, `render`). */
export function jsx(type: JSXElement['type'], props: Record<string, unknown>, key?: string | number): JSXElement {
  return key === undefined ? { type, props } : { type, props: { ...props, key } };
}

export const jsxs = jsx;

export declare namespace JSX {
  type Element = JSXElement;
  type ElementType = string | Component<any>;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements extends Elements, CustomElements {}
}

export type { Child };
