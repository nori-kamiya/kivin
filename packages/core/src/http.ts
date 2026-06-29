export interface HttpErrorOptions {
  body?: unknown;
  headers?: HeadersInit;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: HeadersInit | undefined;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = Object.prototype.hasOwnProperty.call(options, 'body') ? options.body : { message };
    this.headers = options.headers;
  }

  toResponse() {
    const headers = new Headers(this.headers);
    if (!headers.has('content-type') && this.body !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }

    return new Response(this.body === undefined ? null : JSON.stringify(this.body), {
      status: this.status,
      headers,
    });
  }
}

export function httpError(status: number, message: string, options: HttpErrorOptions = {}) {
  return new HttpError(status, message, options);
}

export function badRequest(message = 'Bad Request', options: HttpErrorOptions = {}) {
  return httpError(400, message, options);
}

export function unauthorized(message = 'Unauthorized', options: HttpErrorOptions = {}) {
  return httpError(401, message, options);
}

export function notModified(options: HttpErrorOptions = {}) {
  return httpError(304, 'Not Modified', {
    ...options,
    body: undefined,
  });
}

export function forbidden(message = 'Forbidden', options: HttpErrorOptions = {}) {
  return httpError(403, message, options);
}

export function notFound(message = 'Not Found', options: HttpErrorOptions = {}) {
  return httpError(404, message, options);
}

export function conflict(message = 'Conflict', options: HttpErrorOptions = {}) {
  return httpError(409, message, options);
}

export function preconditionFailed(message = 'Precondition Failed', options: HttpErrorOptions = {}) {
  return httpError(412, message, options);
}

export function preconditionRequired(message = 'Precondition Required', options: HttpErrorOptions = {}) {
  return httpError(428, message, options);
}

export function tooManyRequests(message = 'Too Many Requests', options: HttpErrorOptions = {}) {
  return httpError(429, message, options);
}

export function unprocessableEntity(message = 'Unprocessable Entity', options: HttpErrorOptions = {}) {
  return httpError(422, message, options);
}

export function serviceUnavailable(message = 'Service Unavailable', options: HttpErrorOptions = {}) {
  return httpError(503, message, options);
}