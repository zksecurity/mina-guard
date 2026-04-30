import type { NextFunction, Request, Response } from 'express';
import { PublicKey } from 'o1js';
import { z, type ZodRawShape } from 'zod';

const FIELD_STRING_RE = /^\d+$/;

/** Shared Mina base58 public key validator used by params and request bodies. */
export const minaPublicKeySchema = z.string().refine((value) => {
  try {
    PublicKey.fromBase58(value);
    return true;
  } catch {
    return false;
  }
}, { message: 'Invalid Mina public key' });

/** Route param schema for contract/account addresses. */
export const addressParamSchema = minaPublicKeySchema;

/** Route param/body schema for proposal hashes encoded as o1js Field strings. */
export const proposalHashParamSchema = z.string().regex(
  FIELD_STRING_RE,
  'Must be a numeric string'
);

/** Zod query schema that preserves existing bounded integer parsing semantics. */
export function clampedIntQuerySchema(
  fallback: number,
  min: number,
  max: number
) {
  return z.any().transform((input) => {
    const value = typeof input === 'number' ? input : Number(input);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
  });
}

/** Zod query schema for optional block filters that default invalid input to null. */
export const nullableBlockQuerySchema = z.any().transform((input) => {
  if (typeof input !== 'string') return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
});

/** Zod query schema for optional boolean filters encoded as true/false strings. */
export const optionalBooleanQuerySchema = z.any().transform((input) => {
  if (input === 'true') return true;
  if (input === 'false') return false;
  return undefined;
});

/** Zod query schema for optional strings where empty input behaves as missing. */
// TODO: add list of statuses
export const optionalNonEmptyStringQuerySchema = z.any().transform((input) => {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  return input;
});

/** Validates route params and preserves current route-specific 400 error messages. */
export function validateParams<Shape extends ZodRawShape>(
  schema: z.ZodObject<Shape>,
  fieldErrors: Record<string, string>,
  fallback = 'Invalid request params'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        error: getValidationMessage(parsed.error, fieldErrors, fallback),
      });
      return;
    }

    (req as Request & { params: z.infer<typeof schema> }).params = parsed.data;
    next();
  };
}

/** Validates and normalizes query params before a route handler executes. */
export function validateQuery<Shape extends ZodRawShape>(
  schema: z.ZodObject<Shape>,
  errorMessage = 'Invalid query parameters'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: errorMessage });
      return;
    }

    (req as Request & { query: z.infer<typeof schema> }).query = parsed.data;
    next();
  };
}

/** Shared route param schema for :address endpoints. */
export const addressParamsSchema = z.object({
  address: addressParamSchema,
});

/** Shared route param schema for :address/proposals/:proposalHash endpoints. */
export const proposalParamsSchema = z.object({
  address: addressParamSchema,
  proposalHash: proposalHashParamSchema,
});

export type AddressParams = z.infer<typeof addressParamsSchema>;
export type ProposalParams = z.infer<typeof proposalParamsSchema>;

/** Preconfigured address params middleware with standard error messages. */
export const addressParamsMiddleware = validateParams(addressParamsSchema, {
  address: 'Invalid contract address',
});

/** Preconfigured proposal params middleware with standard error messages. */
export const proposalParamsMiddleware = validateParams(proposalParamsSchema, {
  address: 'Invalid contract address',
  proposalHash: 'Invalid proposal hash',
});

function getValidationMessage(
  error: z.ZodError,
  fieldErrors: Record<string, string>,
  fallback: string
): string {
  const issue = error.issues[0];
  const field = typeof issue?.path?.[0] === 'string' ? issue.path[0] : null;
  return (field && fieldErrors[field]) ?? fallback;
}
