// The development JSX runtime (`"jsx": "react-jsxdev"`, and Bun outside production builds).
import { jsx } from './jsx-runtime';
import type { JSXElement } from './types';

export { Fragment, type JSX } from './jsx-runtime';

export function jsxDEV(type: JSXElement['type'], props: Record<string, unknown>, key?: string | number): JSXElement {
  return jsx(type, props, key);
}
