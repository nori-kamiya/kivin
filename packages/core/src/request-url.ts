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
  // Single pass over the URL without slicing out the query first or allocating a visitor closure.
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return undefined;
  }

  let end = url.indexOf('#', queryStart + 1);
  if (end === -1) {
    end = url.length;
  }
  if (end === queryStart + 1) {
    return undefined;
  }

  const result = Object.create(null) as Record<string, string | string[]>;
  let segmentStart = queryStart + 1;
  while (segmentStart < end) {
    let segmentEnd = url.indexOf('&', segmentStart);
    if (segmentEnd === -1 || segmentEnd > end) {
      segmentEnd = end;
    }

    if (segmentEnd !== segmentStart) {
      let separator = url.indexOf('=', segmentStart);
      if (separator === -1 || separator > segmentEnd) {
        separator = segmentEnd;
      }

      if (separator !== segmentStart) {
        const key = decodeQueryComponent(url.slice(segmentStart, separator));
        const value = separator === segmentEnd ? '' : decodeQueryComponent(url.slice(separator + 1, segmentEnd));
        const existing = result[key];
        // A repeated key (`?tag=a&tag=b`, as the generated client sends arrays) becomes an array.
        result[key] = existing === undefined ? value : typeof existing === 'string' ? [existing, value] : (existing.push(value), existing);
      }
    }

    segmentStart = segmentEnd + 1;
  }

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
  const hasPlus = value.indexOf('+') !== -1;
  if (!hasPlus && value.indexOf('%') === -1) {
    return value;
  }

  return decodeURIComponent(hasPlus ? value.replace(/\+/g, ' ') : value);
}