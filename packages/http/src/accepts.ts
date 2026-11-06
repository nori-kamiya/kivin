// Content negotiation helpers (Accept-Encoding for now; see accepts() for the general form).

/** Whether `Accept-Encoding` allows `encoding` (explicitly or via `*`) with a non-zero q. */
export function acceptsEncoding(header: string, encoding: string) {
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name?.trim().toLowerCase() !== encoding && name?.trim() !== '*') {
      return false;
    }
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}
