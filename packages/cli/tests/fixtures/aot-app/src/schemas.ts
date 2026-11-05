import * as v from 'valibot';

export const SearchQuery = v.object({ q: v.optional(v.pipe(v.string(), v.minLength(2))), page: v.optional(v.pipe(v.string(), v.transform(Number))) });
export const IdParams = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number)) });
export const ItemInput = v.object({ name: v.pipe(v.string(), v.minLength(1)), price: v.number() });
export const ItemPatch = v.object({ name: v.optional(v.string()), price: v.optional(v.number()) });
export const Item = v.object({ id: v.number(), name: v.string(), price: v.number() });
export const ErrorBody = v.object({ message: v.string() });
