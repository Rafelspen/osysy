// AggregateError (thrown by pg on connection failures) and a few other
// built-ins have an empty .message, which produces unhelpful "" errors in
// API responses and last_error cells. Fall back to .code / .cause / String().
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const code = (err as any).code;
    if (code) return String(code);
    const cause = (err as any).errors?.[0]?.message;
    if (cause) return cause;
  }
  return String(err);
}
