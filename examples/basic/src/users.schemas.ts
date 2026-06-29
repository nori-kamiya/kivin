import * as v from 'valibot';

export const UserSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
});

export const UserListSchema = v.array(UserSchema);

export const UserIdParamSchema = v.object({
  id: v.string(),
});

export const CreateUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
});

export const ReplaceUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
});

export const PatchUserSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1))),
  email: v.optional(v.pipe(v.string(), v.email())),
});

export const UserSearchQuerySchema = v.object({
  search: v.optional(v.string()),
});

export const ErrorSchema = v.object({
  message: v.string(),
});

export type CreateUserInput = v.InferOutput<typeof CreateUserSchema>;
export type ReplaceUserInput = v.InferOutput<typeof ReplaceUserSchema>;
export type PatchUserInput = v.InferOutput<typeof PatchUserSchema>;
