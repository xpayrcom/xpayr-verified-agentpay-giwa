export class DomainError extends Error {
  constructor(code, message, { status = 400, details = null, cause } = {}) {
    super(message, { cause });
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invariant(condition, code, message, options = {}) {
  if (!condition) {
    throw new DomainError(code, message, options);
  }
}

export function asPublicError(error) {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === null ? {} : { details: error.details }),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
    },
  };
}
