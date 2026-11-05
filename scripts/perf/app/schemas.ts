import * as v from 'valibot';

export const SearchQuerySchema = v.object({ search: v.optional(v.pipe(v.string(), v.minLength(2))) });
export const IdParamSchema = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)) });
export const CreateUserSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)), email: v.pipe(v.string(), v.email()) });
export const PatchUserSchema = v.object({ name: v.optional(v.string()), email: v.optional(v.pipe(v.string(), v.email())) });
export const UserSchema = v.object({ id: v.string(), name: v.string(), email: v.string() });
