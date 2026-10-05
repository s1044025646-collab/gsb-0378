export type ErrorCode =
  | 'INVALID_PARAMS'
  | 'SECRET_OUT_OF_RANGE'
  | 'THRESHOLD_OUT_OF_RANGE'
  | 'SHARE_COUNT_OUT_OF_RANGE'
  | 'THRESHOLD_EXCEEDS_COUNT'
  | 'COEFFICIENT_OUT_OF_RANGE'
  | 'SCHEME_NOT_FOUND'
  | 'SHARE_NOT_FOUND'
  | 'DUPLICATE_X'
  | 'ZERO_X'
  | 'Y_OUT_OF_RANGE'
  | 'X_OUT_OF_RANGE'
  | 'SCHEME_MISMATCH'
  | 'INSUFFICIENT_SHARES'
  | 'CONFLICTING_SHARE'
  | 'DEMO_REQUIRED'
  | 'NOT_ATOMIC'
  | 'INTERNAL_ERROR';

export class ShamirError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ShamirError';
    this.code = code;
    this.details = details;
  }
}
