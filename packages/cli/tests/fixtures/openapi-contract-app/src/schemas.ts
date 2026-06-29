import * as v from 'valibot';

export const ContractSchema = v.object({
  id: v.string(),
  revisionId: v.string(),
  title: v.string(),
  labels: v.array(v.string()),
});

export const ContractListSchema = v.array(ContractSchema);

export const ContractPathSchema = v.object({
  id: v.string(),
});

export const ContractQuerySchema = v.object({
  includeMeta: v.boolean(),
  search: v.optional(v.string()),
});

export const CreateRevisionSchema = v.object({
  title: v.string(),
  labels: v.array(v.string()),
});

export const ErrorSchema = v.object({
  message: v.string(),
});