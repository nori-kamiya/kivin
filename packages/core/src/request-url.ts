export function readNamedQueryParam(url: string, name: string) {
  const query = readQueryString(url);
  if (!query) {
    return undefined;
  }

  const encodedName = encodeURIComponent(name);
  let resolvedValue: string | undefined;

  scanQueryEntries(query, (rawKey, rawValue) => {
    if (rawKey !== encodedName && rawKey !== name) {
      return false;
    }

    resolvedValue = decodeQueryComponent(rawValue);
    return true;
  });

  return resolvedValue;
}

export function readNullableQueryParam(url: string, name: string) {
  return readNamedQueryParam(url, name) ?? null;
}

export function readQueryObject(url: string) {
  const query = readQueryString(url);
  if (!query) {
    return undefined;
  }

  const result = Object.create(null) as Record<string, string>;

  scanQueryEntries(query, (rawKey, rawValue) => {
    if (!rawKey) {
      return false;
    }

    result[decodeQueryComponent(rawKey)] = decodeQueryComponent(rawValue);
    return false;
  });

  return result;
}

export function readPathname(url: string) {
  if (url.startsWith('/')) {
    const queryStart = url.indexOf('?');
    const hashStart = url.indexOf('#');
    const pathEnd = queryStart === -1
      ? (hashStart === -1 ? url.length : hashStart)
      : (hashStart === -1 ? queryStart : Math.min(queryStart, hashStart));

    return url.slice(0, pathEnd) || '/';
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    const authorityStart = url[4] === ':' ? 7 : 8;
    const pathStart = url.indexOf('/', authorityStart);
    if (pathStart === -1) {
      return '/';
    }

    const queryStart = url.indexOf('?', pathStart);
    const hashStart = url.indexOf('#', pathStart);
    const pathEnd = queryStart === -1
      ? (hashStart === -1 ? url.length : hashStart)
      : (hashStart === -1 ? queryStart : Math.min(queryStart, hashStart));

    return url.slice(pathStart, pathEnd) || '/';
  }

  const schemeSeparator = url.indexOf('://');
  const authorityStart = schemeSeparator === -1 ? 0 : schemeSeparator + 3;
  const pathStart = url.indexOf('/', authorityStart);
  if (pathStart === -1) {
    return '/';
  }

  const queryStart = url.indexOf('?', pathStart);
  const hashStart = url.indexOf('#', pathStart);
  const pathEnd = queryStart === -1
    ? (hashStart === -1 ? url.length : hashStart)
    : (hashStart === -1 ? queryStart : Math.min(queryStart, hashStart));

  return url.slice(pathStart, pathEnd) || '/';
}

function readQueryString(url: string) {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return undefined;
  }

  const hashStart = url.indexOf('#', queryStart + 1);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  return query || undefined;
}

function scanQueryEntries(query: string, visit: (rawKey: string, rawValue: string) => boolean) {
  let segmentStart = 0;

  while (segmentStart <= query.length) {
    const segmentEnd = query.indexOf('&', segmentStart);
    const end = segmentEnd === -1 ? query.length : segmentEnd;
    if (end === segmentStart) {
      segmentStart = end + 1;
      continue;
    }

    const separatorIndex = query.indexOf('=', segmentStart);
    const hasValue = separatorIndex !== -1 && separatorIndex < end;
    const rawKey = query.slice(segmentStart, hasValue ? separatorIndex : end);
    const rawValue = hasValue ? query.slice(separatorIndex + 1, end) : '';

    if (visit(rawKey, rawValue)) {
      return;
    }

    segmentStart = end + 1;
  }
}

function decodeQueryComponent(value: string) {
  if (!value.includes('+') && !value.includes('%')) {
    return value;
  }

  return decodeURIComponent(value.includes('+') ? value.replace(/\+/g, ' ') : value);
}