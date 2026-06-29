import type { ContainerLike } from './metadata';
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

    for (const [name, value] of this.queuedResponseHeaders!) {
      response.headers.set(name, value);
    }

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
      target.setResponseHeader(name, value);
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

    for (const [name, value] of this.queuedResponseHeaders ?? []) {
      headers.set(name, value);
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
