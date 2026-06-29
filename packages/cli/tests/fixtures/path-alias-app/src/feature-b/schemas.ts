import * as v from 'valibot';

export const SharedSchema = v.object({
  source: v.literal('b'),
});
