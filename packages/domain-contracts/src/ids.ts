import { z } from 'zod';

/** New entity identifiers: readable type prefix plus 128 bits of lowercase hex entropy. */
export const OpaqueEntityIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*_[0-9a-f]{32}$/,
  'new entity id must contain a prefix and 128-bit opaque suffix',
);

export type OpaqueEntityId = z.infer<typeof OpaqueEntityIdSchema>;
