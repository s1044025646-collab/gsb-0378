/** 统一错误码：API 与 CLI 共用，便于脚本化处理。 */
export const ErrorCodes = {
  INVALID_PARAMS: "INVALID_PARAMS",
  INVALID_SECRET: "INVALID_SECRET",
  INVALID_SHARE: "INVALID_SHARE",
  DUPLICATE_X: "DUPLICATE_X",
  X_OUT_OF_RANGE: "X_OUT_OF_RANGE",
  Y_OUT_OF_RANGE: "Y_OUT_OF_RANGE",
  INSUFFICIENT_SHARES: "INSUFFICIENT_SHARES",
  SCHEME_MISMATCH: "SCHEME_MISMATCH",
  SCHEME_NOT_FOUND: "SCHEME_NOT_FOUND",
  SHARE_NOT_FOUND: "SHARE_NOT_FOUND",
  CONFLICTING_SHARES: "CONFLICTING_SHARES",
  NOT_INVERTIBLE: "NOT_INVERTIBLE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function toErrorPayload(err: unknown): { code: ErrorCode; message: string; status: number; details?: unknown } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, status: err.httpStatus, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: ErrorCodes.INTERNAL, message, status: 500 };
}
