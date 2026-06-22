export type ShqlErrorCode =
  | "SCHEMA_ERROR"
  | "QUERY_ERROR"
  | "VALIDATION_ERROR"
  | "ADAPTER_ERROR"
  | "AUTH_ERROR"
  | "CONFLICT";

export class ShqlError extends Error {
  readonly code: ShqlErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ShqlErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ShqlError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: ShqlErrorCode,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new ShqlError(code, message, details);
}
