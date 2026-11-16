// Element and attribute types. Attributes cover the global ones, ARIA / data-*, and the element-specific
// ones of common elements; other standard elements take the global attributes.

declare const RAW_BRAND: unique symbol;

/** HTML that is written as is (from `raw()` or `jsonScript()`), never escaped. */
export interface RawHtml {
  readonly [RAW_BRAND]: true;
  readonly html: string;
}

export interface JSXElement {
  readonly type: string | Component<any> | typeof Fragment;
  readonly props: Record<string, unknown>;
}

type SyncChild = JSXElement | RawHtml | string | number | bigint | boolean | null | undefined | readonly SyncChild[];

/** What a component may return or take as children (a promise is awaited while rendering). */
export type Child = SyncChild | Promise<SyncChild> | readonly Child[];

export type Component<P = Record<string, unknown>> = (props: P) => Child | Promise<Child>;

export const Fragment: unique symbol = Symbol.for('@kivinjs/jsx Fragment') as never;

type Booleanish = boolean | 'true' | 'false';
type Numberish = number | string;

/** `class`: a string, or a list / record of class names (falsy entries are dropped). */
export type ClassValue = string | null | undefined | false | readonly ClassValue[] | Readonly<Record<string, unknown>>;

/** `style`: a string, or properties (camelCase or kebab-case, custom properties as `--name`). Numbers are written as is. */
export type StyleValue = string | Readonly<Record<string, string | number | null | undefined>>;

type AriaAttributes = { [K in `aria-${string}`]?: string | number | boolean | null | undefined };
type DataAttributes = { [K in `data-${string}`]?: string | number | boolean | null | undefined };

export interface HTMLAttributes extends AriaAttributes, DataAttributes {
  children?: Child;
  key?: string | number;
  /** `{ __html }` written as the element's content without escaping. */
  dangerouslySetInnerHTML?: { __html: string };
  accesskey?: string;
  autocapitalize?: string;
  autofocus?: boolean;
  class?: ClassValue;
  className?: ClassValue;
  contenteditable?: Booleanish | 'plaintext-only';
  dir?: 'ltr' | 'rtl' | 'auto';
  draggable?: Booleanish;
  enterkeyhint?: string;
  hidden?: boolean | 'until-found';
  id?: string;
  inert?: boolean;
  inputmode?: string;
  is?: string;
  itemid?: string;
  itemprop?: string;
  itemref?: string;
  itemscope?: boolean;
  itemtype?: string;
  lang?: string;
  nonce?: string;
  popover?: boolean | 'auto' | 'manual';
  role?: string;
  slot?: string;
  spellcheck?: Booleanish;
  style?: StyleValue;
  tabindex?: Numberish;
  title?: string;
  translate?: 'yes' | 'no';
}

interface AnchorAttributes extends HTMLAttributes {
  download?: string | boolean;
  href?: string;
  hreflang?: string;
  ping?: string;
  referrerpolicy?: string;
  rel?: string;
  target?: string;
  type?: string;
}

interface FormControlAttributes extends HTMLAttributes {
  disabled?: boolean;
  form?: string;
  name?: string;
}

interface InputAttributes extends FormControlAttributes {
  accept?: string;
  alt?: string;
  autocomplete?: string;
  checked?: boolean;
  dirname?: string;
  formaction?: string;
  formenctype?: string;
  formmethod?: string;
  formnovalidate?: boolean;
  formtarget?: string;
  height?: Numberish;
  list?: string;
  max?: Numberish;
  maxlength?: Numberish;
  min?: Numberish;
  minlength?: Numberish;
  multiple?: boolean;
  pattern?: string;
  placeholder?: string;
  readonly?: boolean;
  required?: boolean;
  size?: Numberish;
  src?: string;
  step?: Numberish;
  type?: string;
  value?: string | number | readonly string[];
  width?: Numberish;
}

interface ButtonAttributes extends FormControlAttributes {
  formaction?: string;
  formenctype?: string;
  formmethod?: string;
  formnovalidate?: boolean;
  formtarget?: string;
  popovertarget?: string;
  popovertargetaction?: 'hide' | 'show' | 'toggle';
  type?: 'submit' | 'reset' | 'button';
  value?: string | number;
}

interface SelectAttributes extends FormControlAttributes {
  autocomplete?: string;
  multiple?: boolean;
  required?: boolean;
  size?: Numberish;
}

interface OptionAttributes extends HTMLAttributes {
  disabled?: boolean;
  label?: string;
  selected?: boolean;
  value?: string | number;
}

interface TextareaAttributes extends FormControlAttributes {
  autocomplete?: string;
  cols?: Numberish;
  maxlength?: Numberish;
  minlength?: Numberish;
  placeholder?: string;
  readonly?: boolean;
  required?: boolean;
  rows?: Numberish;
  wrap?: string;
}

interface FormAttributes extends HTMLAttributes {
  'accept-charset'?: string;
  action?: string;
  autocomplete?: string;
  enctype?: string;
  method?: string;
  name?: string;
  novalidate?: boolean;
  target?: string;
}

interface LabelAttributes extends HTMLAttributes {
  for?: string;
  htmlFor?: string;
}

interface MediaAttributes extends HTMLAttributes {
  alt?: string;
  autoplay?: boolean;
  controls?: boolean;
  crossorigin?: string;
  decoding?: 'sync' | 'async' | 'auto';
  fetchpriority?: 'high' | 'low' | 'auto';
  height?: Numberish;
  loading?: 'eager' | 'lazy';
  loop?: boolean;
  muted?: boolean;
  playsinline?: boolean;
  poster?: string;
  preload?: string;
  referrerpolicy?: string;
  sizes?: string;
  src?: string;
  srcset?: string;
  type?: string;
  usemap?: string;
  width?: Numberish;
}

interface LinkAttributes extends HTMLAttributes {
  as?: string;
  crossorigin?: string;
  disabled?: boolean;
  fetchpriority?: 'high' | 'low' | 'auto';
  href?: string;
  hreflang?: string;
  imagesizes?: string;
  imagesrcset?: string;
  integrity?: string;
  media?: string;
  referrerpolicy?: string;
  rel?: string;
  sizes?: string;
  type?: string;
}

interface MetaAttributes extends HTMLAttributes {
  charset?: string;
  content?: string;
  'http-equiv'?: string;
  media?: string;
  name?: string;
  property?: string;
}

interface ScriptAttributes extends HTMLAttributes {
  async?: boolean;
  crossorigin?: string;
  defer?: boolean;
  fetchpriority?: 'high' | 'low' | 'auto';
  integrity?: string;
  nomodule?: boolean;
  referrerpolicy?: string;
  src?: string;
  type?: string;
}

interface StyleAttributes extends HTMLAttributes {
  media?: string;
}

interface IframeAttributes extends HTMLAttributes {
  allow?: string;
  allowfullscreen?: boolean;
  height?: Numberish;
  loading?: 'eager' | 'lazy';
  name?: string;
  referrerpolicy?: string;
  sandbox?: string;
  src?: string;
  srcdoc?: string;
  width?: Numberish;
}

interface TableCellAttributes extends HTMLAttributes {
  abbr?: string;
  colspan?: Numberish;
  headers?: string;
  rowspan?: Numberish;
  scope?: string;
}

interface ColAttributes extends HTMLAttributes {
  span?: Numberish;
}

interface OlAttributes extends HTMLAttributes {
  reversed?: boolean;
  start?: Numberish;
  type?: string;
}

interface LiAttributes extends HTMLAttributes {
  value?: Numberish;
}

interface QuoteAttributes extends HTMLAttributes {
  cite?: string;
}

interface TimeAttributes extends HTMLAttributes {
  datetime?: string;
}

interface DetailsAttributes extends HTMLAttributes {
  name?: string;
  open?: boolean;
}

interface DialogAttributes extends HTMLAttributes {
  open?: boolean;
}

interface SourceAttributes extends HTMLAttributes {
  media?: string;
  sizes?: string;
  src?: string;
  srcset?: string;
  type?: string;
}

interface TrackAttributes extends HTMLAttributes {
  default?: boolean;
  kind?: string;
  label?: string;
  src?: string;
  srclang?: string;
}

interface MeterAttributes extends HTMLAttributes {
  high?: Numberish;
  low?: Numberish;
  max?: Numberish;
  min?: Numberish;
  optimum?: Numberish;
  value?: Numberish;
}

interface ProgressAttributes extends HTMLAttributes {
  max?: Numberish;
  value?: Numberish;
}

interface BaseAttributes extends HTMLAttributes {
  href?: string;
  target?: string;
}

interface OptgroupAttributes extends HTMLAttributes {
  disabled?: boolean;
  label?: string;
}

interface FieldsetAttributes extends HTMLAttributes {
  disabled?: boolean;
  form?: string;
  name?: string;
}

interface OutputAttributes extends HTMLAttributes {
  for?: string;
  form?: string;
  name?: string;
}

interface ObjectAttributes extends HTMLAttributes {
  data?: string;
  form?: string;
  height?: Numberish;
  name?: string;
  type?: string;
  width?: Numberish;
}

interface CanvasAttributes extends HTMLAttributes {
  height?: Numberish;
  width?: Numberish;
}

interface HtmlAttributes extends HTMLAttributes {
  xmlns?: string;
}

interface SvgAttributes extends HTMLAttributes {
  [attribute: string]: unknown;
}

type Global = HTMLAttributes;

interface BaseElements {
  a: AnchorAttributes; abbr: Global; address: Global; area: AnchorAttributes & { alt?: string; coords?: string; shape?: string }; article: Global; aside: Global;
  audio: MediaAttributes; b: Global; base: BaseAttributes; bdi: Global; bdo: Global; blockquote: QuoteAttributes; body: Global; br: Global;
  button: ButtonAttributes; canvas: CanvasAttributes; caption: Global; cite: Global; code: Global; col: ColAttributes; colgroup: ColAttributes;
  data: Global & { value?: string }; datalist: Global; dd: Global; del: QuoteAttributes & { datetime?: string }; details: DetailsAttributes; dfn: Global;
  dialog: DialogAttributes; div: Global; dl: Global; dt: Global; em: Global; embed: MediaAttributes; fieldset: FieldsetAttributes;
  figcaption: Global; figure: Global; footer: Global; form: FormAttributes; h1: Global; h2: Global; h3: Global; h4: Global; h5: Global; h6: Global;
  head: Global; header: Global; hgroup: Global; hr: Global; html: HtmlAttributes; i: Global; iframe: IframeAttributes; img: MediaAttributes & { ismap?: boolean };
  input: InputAttributes; ins: QuoteAttributes & { datetime?: string }; kbd: Global; label: LabelAttributes; legend: Global; li: LiAttributes;
  link: LinkAttributes; main: Global; map: Global & { name?: string }; mark: Global; menu: Global; meta: MetaAttributes; meter: MeterAttributes;
  nav: Global; noscript: Global; object: ObjectAttributes; ol: OlAttributes; optgroup: OptgroupAttributes; option: OptionAttributes;
  output: OutputAttributes; p: Global; picture: Global; pre: Global; progress: ProgressAttributes; q: QuoteAttributes; rp: Global; rt: Global;
  ruby: Global; s: Global; samp: Global; script: ScriptAttributes; search: Global; section: Global; select: SelectAttributes; slot: Global & { name?: string };
  small: Global; source: SourceAttributes; span: Global; strong: Global; style: StyleAttributes; sub: Global; summary: Global; sup: Global;
  table: Global; tbody: Global; td: TableCellAttributes; template: Global & { shadowrootmode?: 'open' | 'closed' }; textarea: TextareaAttributes;
  tfoot: Global; th: TableCellAttributes; thead: Global; time: TimeAttributes; title: Global; tr: Global; track: TrackAttributes; u: Global;
  ul: Global; var: Global; video: MediaAttributes; wbr: Global;
  svg: SvgAttributes; math: SvgAttributes;
  circle: SvgAttributes; clipPath: SvgAttributes; defs: SvgAttributes; ellipse: SvgAttributes; g: SvgAttributes; line: SvgAttributes;
  linearGradient: SvgAttributes; mask: SvgAttributes; path: SvgAttributes; pattern: SvgAttributes; polygon: SvgAttributes; polyline: SvgAttributes;
  radialGradient: SvgAttributes; rect: SvgAttributes; stop: SvgAttributes; symbol: SvgAttributes; text: SvgAttributes; tspan: SvgAttributes; use: SvgAttributes;
}

/** Attributes accept `null` / `undefined` (not written), also under `exactOptionalPropertyTypes`. */
type Optional<T> = { [K in keyof T]?: T[K] | null | undefined };

export type IntrinsicElements = { [K in keyof BaseElements]: Optional<BaseElements[K]> };

/** Custom elements (`<my-widget>`) take the global attributes plus any others. */
export type CustomElements = { [K in `${string}-${string}`]: Optional<HTMLAttributes> & { [attribute: string]: unknown } };
