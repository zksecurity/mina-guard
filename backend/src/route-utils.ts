import type { Request, Response, NextFunction } from 'express';

/** Wraps async route handlers so thrown errors are forwarded to Express error middleware. */
export function wrapAsyncRoute() {
  return (handler: (req: Request, res: Response) => Promise<void>) => {
    return (req: Request, res: Response, next: NextFunction) => {
      void handler(req, res).catch(next);
    };
  };
}
