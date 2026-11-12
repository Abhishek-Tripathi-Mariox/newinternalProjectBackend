/**
 * Operational errors with an HTTP status and a stable machine-readable `code`.
 * Anything thrown that is NOT an AppError is treated as a bug (500, details hidden).
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', message, details);
export const validationError = (details, message = 'Validation failed') => new AppError(422, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = "You don't have permission to do this") => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
/** Business-rule violation the user can fix (e.g. "Logged hours exceed time worked"). */
export const unprocessable = (message, details) => new AppError(422, 'RULE_VIOLATION', message, details);
