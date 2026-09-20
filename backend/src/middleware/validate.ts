import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

/** Validates and replaces req.body / req.query / req.params from a Zod schema. */
export const validate =
  (schema: { body?: AnyZodObject; query?: AnyZodObject; params?: AnyZodObject }) =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) req.body = schema.body.parse(req.body);
      if (schema.query) req.query = schema.query.parse(req.query) as never;
      if (schema.params) req.params = schema.params.parse(req.params) as never;
      next();
    } catch (err) {
      if (err instanceof ZodError) return next(err);
      next(err);
    }
  };
