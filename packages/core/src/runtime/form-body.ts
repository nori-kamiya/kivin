// Form request bodies for `@Consumes('multipart/form-data' | 'application/x-www-form-urlencoded')`.
//
// Every body reader in the runtime (specialized executors, AOT executors, `context.jsonBody()`) goes
// through `request.json()`. For a form route the request's own `json` / `formData` are replaced, per
// request, with readers that parse the body once as `FormData` and expose it as a plain object, so all
// those paths validate and pass the form without knowing about it. JSON routes are untouched.
import type { BodyMediaType } from '../metadata';
import { HttpError } from '../http';
import type { CompiledRoute } from './types';

export type FormBodyValue = FormDataEntryValue | FormDataEntryValue[];

const FORM_MEDIA_TYPES = new Set<BodyMediaType>(['multipart/form-data', 'application/x-www-form-urlencoded']);
const readRequestFormData = Request.prototype.formData;

export function isFormMediaType(mediaType: BodyMediaType | undefined): boolean {
  return mediaType !== undefined && FORM_MEDIA_TYPES.has(mediaType);
}

/** Fields become strings or `File`s; a repeated field becomes an array (in order). */
export function formDataToObject(formData: FormData): Record<string, FormBodyValue> {
  const result: Record<string, FormBodyValue> = Object.create(null);
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

function isFormContentType(contentType: string | null) {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mediaType === 'multipart/form-data' || mediaType === 'application/x-www-form-urlencoded';
}

function installFormBody(request: Request) {
  let pending: Promise<FormData> | undefined;
  const formData = () => (pending ??= readRequestFormData.call(request));
  const json = () => {
    if (!isFormContentType(request.headers.get('content-type'))) {
      return Promise.reject(new HttpError(415, 'Unsupported Media Type: expected multipart/form-data or application/x-www-form-urlencoded'));
    }
    return formData().then(formDataToObject, () => {
      throw new HttpError(400, 'Invalid form body');
    });
  };
  Object.defineProperty(request, 'formData', { value: formData, configurable: true });
  Object.defineProperty(request, 'json', { value: json, configurable: true });
}

/** Wraps a form route's executor so its body readers see the parsed form. */
export function withFormBody<TSchema>(compiled: CompiledRoute<TSchema>): CompiledRoute<TSchema> {
  const execute = compiled.execute;
  return {
    ...compiled,
    execute: (request, params) => {
      installFormBody(request);
      return execute(request, params);
    },
  };
}
