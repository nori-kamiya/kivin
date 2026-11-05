import { parseCookies, serializeCookie, serializeDeletedCookie, type CookieOptions } from './cookies';
import type { ContainerLike } from './metadata';
import { createEventStream, type EventStreamHandler, type EventStreamOptions } from './sse';
import { readNullableQueryParam } from './request-url';
import { createJsonResponse, createJsonResponseCreated, createJsonResponseWithHeader, createJsonResponseWithStatus, createJsonResponseWithStatusAndHeader, createNoContentResponse, createNoContentResponseWithHeader, createTextResponse } from './response';
import type { Token } from './types';

class RequestContextRequestApi {
  constructor(
    readonly raw: Request,
    private readonly params: Record<string, string>,
  ) {}

  param(name: string) {
    return this.params[name];
  }

  query(name: string) {
    return readNullableQueryParam(this.raw.url, name);
  }
}

function copyHeaders(source: Headers, target: Headers) {
  for (const [name, value] of source) {
    if (name === 'set-cookie') {
      target.append(name, value);
    } else {
      target.set(name, value);
    }
  }
}

export class ResponseState {
  private queuedResponseHeaderName: string | undefined;
  private queuedResponseHeaderValue: string | undefined;
  private queuedResponseHeaders: Headers | undefined;
  private queuedResponseStatus: number | undefined;
  private queuedResponseStatusText: string | undefined;

  setResponseHeader(name: string, value: string) {
    if (this.queuedResponseHeaders) {
      this.queuedResponseHeaders.set(name, value);
      return;
    }

    if (!this.queuedResponseHeaderName || this.queuedResponseHeaderName === name) {
      this.queuedResponseHeaderName = name;
      this.queuedResponseHeaderValue = value;
      return;
    }

    this.queuedResponseHeaders = new Headers([
      [this.queuedResponseHeaderName, this.queuedResponseHeaderValue!],
      [name, value],
    ]);
    this.queuedResponseHeaderName = undefined;
    this.queuedResponseHeaderValue = undefined;
  }

  /** Adds a header value without replacing earlier ones (needed for multiple `Set-Cookie`). */
  appendResponseHeader(name: string, value: string) {
    if (!this.queuedResponseHeaders) {
      this.queuedResponseHeaders = new Headers();
      if (this.queuedResponseHeaderName) {
        this.queuedResponseHeaders.set(this.queuedResponseHeaderName, this.queuedResponseHeaderValue!);
        this.queuedResponseHeaderName = undefined;
        this.queuedResponseHeaderValue = undefined;
      }
    }
    this.queuedResponseHeaders.append(name, value);
  }

  setResponseStatus(status: number, statusText?: string) {
    this.queuedResponseStatus = status;
    this.queuedResponseStatusText = statusText;
  }

  json(data: unknown, init: ResponseInit = {}): Response {
    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      if (!init.headers && init.status === undefined && init.statusText === undefined) {
        return createJsonResponse(data);
      }

      if (!init.headers && init.status !== undefined && init.statusText === undefined) {
        return createJsonResponseWithStatus(data, init.status);
      }

      return createJsonResponse(data, init);
    }

    const queuedHeader = this.getSingleQueuedResponseHeader();
    const status = init.status ?? this.queuedResponseStatus;
    const statusText = init.statusText ?? this.queuedResponseStatusText;
    if (queuedHeader && !init.headers && status === undefined && statusText === undefined) {
      const response = createJsonResponseWithHeader(data, queuedHeader[0], queuedHeader[1]);
      this.clearQueuedResponseState();
      return response;
    }

    if (queuedHeader && !init.headers && status !== undefined && statusText === undefined) {
      const response = createJsonResponseWithStatusAndHeader(data, status, queuedHeader[0], queuedHeader[1]);
      this.clearQueuedResponseState();
      return response;
    }

    if (!init.headers && status !== undefined && statusText === undefined && !this.queuedResponseHeaderName && !this.queuedResponseHeaders) {
      const response = createJsonResponseWithStatus(data, status);
      this.clearQueuedResponseState();
      return response;
    }

    const response = createJsonResponse(data, this.mergeResponseInit(init));
    this.clearQueuedResponseState();
    return response;
  }

  text(data: string, init: ResponseInit = {}): Response {
    const response = createTextResponse(data, this.mergeResponseInit(init));
    this.clearQueuedResponseState();
    return response;
  }

  noContent(init: ResponseInit = {}): Response {
    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      return createNoContentResponse(init);
    }

    const queuedHeader = this.getSingleQueuedResponseHeader();
    const status = init.status ?? this.queuedResponseStatus;
    const statusText = init.statusText ?? this.queuedResponseStatusText;
    if (queuedHeader && !init.headers && (status === undefined || status === 204) && statusText === undefined) {
      const response = createNoContentResponseWithHeader(queuedHeader[0], queuedHeader[1]);
      this.clearQueuedResponseState();
      return response;
    }

    const response = createNoContentResponse(this.mergeResponseInit(init));
    this.clearQueuedResponseState();
    return response;
  }

  respond(data: unknown, init: ResponseInit = {}): Response {
    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      const status = init.status;
      if (data === undefined && status === 204) {
        return createNoContentResponse(init);
      }

      if (!init.headers && init.statusText === undefined) {
        return status === undefined
          ? createJsonResponse(data)
          : createJsonResponseWithStatus(data, status);
      }

      return createJsonResponse(data, init);
    }

    const status = init.status ?? this.queuedResponseStatus;
    if (data === undefined && status === 204) {
      return this.noContent(init);
    }

    return this.json(data, init);
  }

  respondDefaultOk(data: unknown): Response {
    if (data === undefined && this.queuedResponseStatus === 204 && this.queuedResponseStatusText === undefined) {
      return this.noContent();
    }

    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      return createJsonResponse(data);
    }

    const headerName = this.queuedResponseHeaderName;
    if (headerName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      const response = createJsonResponseWithHeader(data, headerName, this.queuedResponseHeaderValue!);
      this.clearQueuedResponseState();
      return response;
    }

    return this.respond(data);
  }

  respondDefaultCreated(data: unknown): Response {
    if (data === undefined && this.queuedResponseStatus === 204 && this.queuedResponseStatusText === undefined) {
      return this.noContent();
    }

    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      return createJsonResponseCreated(data);
    }

    const headerName = this.queuedResponseHeaderName;
    if (headerName && !this.queuedResponseHeaders && this.queuedResponseStatus === undefined && this.queuedResponseStatusText === undefined) {
      const response = createJsonResponseWithStatusAndHeader(data, 201, headerName, this.queuedResponseHeaderValue!);
      this.clearQueuedResponseState();
      return response;
    }

    return this.respond(data, { status: 201 });
  }

  hasQueuedNoContentResponse() {
    return this.queuedResponseStatus === 204 && this.queuedResponseStatusText === undefined;
  }

  hasQueuedResponseState() {
    return this.queuedResponseStatus !== undefined || this.queuedResponseHeaderName !== undefined || this.queuedResponseHeaders !== undefined;
  }

  applyResponseHeaders(response: Response): Response {
    const headerName = this.queuedResponseHeaderName;
    if (!headerName && !this.queuedResponseHeaders) {
      this.clearQueuedResponseState();
      return response;
    }

    if (headerName && !this.queuedResponseHeaders) {
      response.headers.set(headerName, this.queuedResponseHeaderValue!);
      this.clearQueuedResponseState();
      return response;
    }

    copyHeaders(this.queuedResponseHeaders!, response.headers);

    this.clearQueuedResponseState();
    return response;
  }

  copyResponseStateTo(target: Pick<ResponseState, 'setResponseHeader' | 'setResponseStatus'>) {
    if (this.queuedResponseStatus !== undefined) {
      target.setResponseStatus(this.queuedResponseStatus, this.queuedResponseStatusText);
    }

    if (this.queuedResponseHeaderName) {
      target.setResponseHeader(this.queuedResponseHeaderName, this.queuedResponseHeaderValue!);
    }

    for (const [name, value] of this.queuedResponseHeaders ?? []) {
      if (name === 'set-cookie' && 'appendResponseHeader' in target && typeof target.appendResponseHeader === 'function') {
        target.appendResponseHeader(name, value);
      } else {
        target.setResponseHeader(name, value);
      }
    }
  }

  private getSingleQueuedResponseHeader(): [string, string] | undefined {
    if (this.queuedResponseHeaders || !this.queuedResponseHeaderName) {
      return undefined;
    }

    return [this.queuedResponseHeaderName, this.queuedResponseHeaderValue!];
  }

  private clearQueuedResponseState() {
    this.queuedResponseHeaderName = undefined;
    this.queuedResponseHeaderValue = undefined;
    this.queuedResponseHeaders = undefined;
    this.queuedResponseStatus = undefined;
    this.queuedResponseStatusText = undefined;
  }

  private mergeResponseInit(init: ResponseInit): ResponseInit {
    const status = init.status ?? this.queuedResponseStatus;
    const statusText = init.statusText ?? this.queuedResponseStatusText;

    if (!this.queuedResponseHeaderName && !this.queuedResponseHeaders) {
      if (status === init.status && statusText === init.statusText) {
        return init;
      }

      return {
        ...init,
        ...(status !== undefined ? { status } : null),
        ...(statusText !== undefined ? { statusText } : null),
      };
    }

    if (this.queuedResponseHeaderName && !init.headers) {
      return {
        ...init,
        ...(status !== undefined ? { status } : null),
        ...(statusText !== undefined ? { statusText } : null),
        headers: {
          [this.queuedResponseHeaderName]: this.queuedResponseHeaderValue!,
        },
      };
    }

    const headers = new Headers(init.headers);
    if (this.queuedResponseHeaderName) {
      headers.set(this.queuedResponseHeaderName, this.queuedResponseHeaderValue!);
    }

    if (this.queuedResponseHeaders) {
      copyHeaders(this.queuedResponseHeaders, headers);
    }

    return {
      ...init,
      ...(status !== undefined ? { status } : null),
      ...(statusText !== undefined ? { statusText } : null),
      headers,
    };
  }
}

export class RequestContext {
  private bodyCache: unknown = undefined;
  private bodyLoaded = false;
  private requestApi: RequestContextRequestApi | undefined;
  private readonly responseState = new ResponseState();
  private storeKey: string | undefined;
  private storeValue: unknown = undefined;
  private store: Record<string, unknown> | undefined;
  private cookieCache: Record<string, string> | undefined;
  private formCache: Promise<FormData> | undefined;

  constructor(
    readonly request: Request,
    readonly params: Record<string, string>,
    private readonly container: ContainerLike,
  ) {
  }

  get req() {
    this.requestApi ??= new RequestContextRequestApi(this.request, this.params);

    return this.requestApi;
  }

  inject<T>(token: Token<T>): T {
    return this.container.resolve(token);
  }

  set<T>(key: string, value: T) {
    if (this.store) {
      this.store[key] = value;
      return;
    }

    if (!this.storeKey || this.storeKey === key) {
      this.storeKey = key;
      this.storeValue = value;
      return;
    }

    this.store = Object.create(null) as Record<string, unknown>;
    this.store[this.storeKey] = this.storeValue;
    this.store[key] = value;
    this.storeKey = undefined;
    this.storeValue = undefined;
  }

  get<T>(key: string): T | undefined {
    if (this.store) {
      return this.store[key] as T | undefined;
    }

    if (this.storeKey === key) {
      return this.storeValue as T | undefined;
    }

    return undefined;
  }

  setResponseHeader(name: string, value: string) {
    this.responseState.setResponseHeader(name, value);
  }

  appendResponseHeader(name: string, value: string) {
    this.responseState.appendResponseHeader(name, value);
  }

  /** Request cookies, parsed once per request. */
  cookies(): Record<string, string> {
    this.cookieCache ??= parseCookies(this.request.headers.get('cookie'));
    return this.cookieCache;
  }

  cookie(name: string): string | undefined {
    return this.cookies()[name];
  }

  /** Queues a `Set-Cookie` header on the response; can be called several times. */
  setCookie(name: string, value: string, options?: CookieOptions) {
    this.responseState.appendResponseHeader('set-cookie', serializeCookie(name, value, options));
  }

  deleteCookie(name: string, options?: Pick<CookieOptions, 'domain' | 'path' | 'secure' | 'sameSite' | 'partitioned'>) {
    this.responseState.appendResponseHeader('set-cookie', serializeDeletedCookie(name, options));
  }

  /** The request body as `FormData` (multipart or urlencoded), read once per request. */
  formData(): Promise<FormData> {
    this.formCache ??= this.request.formData();
    return this.formCache;
  }

  /**
   * The request body as a plain object: each field is a string or `File`, and repeated fields become
   * arrays. Validate it with your schema library (e.g. `v.object({ avatar: v.file(), name: v.string() })`).
   */
  async form(): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
    const formData = await this.formData();
    const result: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.create(null);
    for (const [key, value] of formData) {
      const existing = result[key];
      if (existing === undefined) {
        result[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    }
    return result;
  }

  /** Server-Sent Events response; queued response headers (e.g. cookies) are applied to it. */
  sse(handler: EventStreamHandler, options?: EventStreamOptions): Response {
    return this.responseState.applyResponseHeaders(createEventStream(this.request, handler, options));
  }

  setResponseStatus(status: number, statusText?: string) {
    this.responseState.setResponseStatus(status, statusText);
  }

  primeJsonBody(value: unknown) {
    this.bodyCache = value;
    this.bodyLoaded = true;
  }

  async jsonBody<T>(): Promise<T> {
    if (!this.bodyLoaded) {
      this.bodyCache = await this.request.json();
      this.bodyLoaded = true;
    }

    return this.bodyCache as T;
  }

  json(data: unknown, init: ResponseInit = {}): Response {
    return this.responseState.json(data, init);
  }

  text(data: string, init: ResponseInit = {}): Response {
    return this.responseState.text(data, init);
  }

  noContent(init: ResponseInit = {}): Response {
    return this.responseState.noContent(init);
  }

  respond(data: unknown, init: ResponseInit = {}): Response {
    return this.responseState.respond(data, init);
  }

  respondDefaultOk(data: unknown): Response {
    return this.responseState.respondDefaultOk(data);
  }

  respondDefaultCreated(data: unknown): Response {
    return this.responseState.respondDefaultCreated(data);
  }

  hasQueuedNoContentResponse() {
    return this.responseState.hasQueuedNoContentResponse();
  }

  hasQueuedResponseState() {
    return this.responseState.hasQueuedResponseState();
  }

  applyResponseHeaders(response: Response): Response {
    return this.responseState.applyResponseHeaders(response);
  }

  copyResponseStateTo(target: Pick<ResponseState, 'setResponseHeader' | 'setResponseStatus'>) {
    this.responseState.copyResponseStateTo(target);
  }
}
