import { Cause, Runtime } from "effect";
import { ExecutionTerminationError } from "./processTermination.js";
import { VerificationError } from "./Verification.js";

export const getVerificationError = (
  error: unknown,
): VerificationError | undefined => {
  if (error instanceof VerificationError) return error;
  if (!Runtime.isFiberFailure(error)) return undefined;
  return Array.from(Cause.defects(error[Runtime.FiberFailureCauseId])).find(
    (defect): defect is VerificationError =>
      defect instanceof VerificationError,
  );
};

/** Preserve termination failure when a public API would otherwise unwrap abort. */
export const getExecutionTerminationError = (
  error: unknown,
): ExecutionTerminationError | undefined => {
  if (error instanceof ExecutionTerminationError) return error;
  if (!Runtime.isFiberFailure(error)) return undefined;
  return Array.from(Cause.defects(error[Runtime.FiberFailureCauseId])).find(
    (defect): defect is ExecutionTerminationError =>
      defect instanceof ExecutionTerminationError,
  );
};
