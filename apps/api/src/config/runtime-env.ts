function hasValue(input: string | undefined): boolean {
  return typeof input === "string" && input.trim().length > 0;
}

export function isServerlessRuntime(): boolean {
  return (
    hasValue(process.env.VERCEL) ||
    hasValue(process.env.VERCEL_ENV) ||
    hasValue(process.env.VERCEL_URL) ||
    hasValue(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    hasValue(process.env.LAMBDA_TASK_ROOT) ||
    hasValue(process.env.AWS_EXECUTION_ENV)
  );
}

export function shouldStartBackgroundLoops(): boolean {
  return process.env.NODE_ENV !== "test" && !isServerlessRuntime();
}
