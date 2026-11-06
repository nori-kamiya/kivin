// Helpers shared by the observability middleware.
/** Sets a header, copying the response first when its headers are immutable (e.g. a proxied fetch). */
export function withHeader(response: Response, name: string, value: string, append = false): Response {
  try {
    if (append) {
      response.headers.append(name, value);
    } else {
      response.headers.set(name, value);
    }
    return response;
  } catch {
    const copy = new Response(response.body, response);
    if (append) {
      copy.headers.append(name, value);
    } else {
      copy.headers.set(name, value);
    }
    return copy;
  }
}
