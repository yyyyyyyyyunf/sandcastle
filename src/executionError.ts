import { PreparationError } from "./Preparation.js";
import { StructuredOutputError } from "./Output.js";
import { Cause, Runtime } from "effect";
import { ExecutionTerminationError } from "./processTermination.js";
import { VerificationError } from "./Verification.js";

export const getVerificationError = (
  error: unknown,
): VerificationError | PreparationError | StructuredOutputError | undefined => {
  if (
    error instanceof VerificationError ||
    error instanceof PreparationError ||
    error instanceof StructuredOutputError
  )
    return error;
  if (!Runtime.isFiberFailure(error)) return undefined;
  return Array.from(Cause.defects(error[Runtime.FiberFailureCauseId])).find(
    (
      defect,
    ): defect is VerificationError | PreparationError | StructuredOutputError =>
      defect instanceof VerificationError ||
      defect instanceof PreparationError ||
      defect instanceof StructuredOutputError,
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
