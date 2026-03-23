import type { NextFunction, Request, Response } from 'express';
import { PublicKey } from 'o1js';
import { z, type ZodRawShape } from 'zod';

const PROPOSAL_HASH_RE = /^[0-9a-fA-F]{64}$/;

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

/** Route param/body schema for proposal hashes. */
export const proposalHashParamSchema = z.string().regex(
  PROPOSAL_HASH_RE,
  'Must be a 64-char hex string'
);

/** Zod query schema that preserves existing bounded integer parsing semantics. */
export function clampedIntQuerySchema(
  fallback: number,
  min: number,
  max: number
) {
  return z.any().transform((input) => {
    if (typeof input !== 'string') return fallback;
    const value = Number(input);
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

    next();
  };
}

function getValidationMessage(
  error: z.ZodError,
  fieldErrors: Record<string, string>,
  fallback: string
): string {
  const issue = error.issues[0];
  const field = typeof issue?.path?.[0] === 'string' ? issue.path[0] : null;
  return (field && fieldErrors[field]) ?? fallback;
}
