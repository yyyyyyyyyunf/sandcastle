import { Cause, Runtime } from "effect";
import { PreparationError } from "./Preparation.js";
import { StructuredOutputError } from "./Output.js";
import { ExecutionTerminationError } from "./processTermination.js";
import { VerificationError } from "./Verification.js";

type WorkflowError =
  | VerificationError
  | PreparationError
  | StructuredOutputError;
const isWorkflowError = (error: unknown): error is WorkflowError =>
  error instanceof VerificationError ||
  error instanceof PreparationError ||
  error instanceof StructuredOutputError;

const findError = <T>(
  error: unknown,
  matches: (value: unknown) => value is T,
): T | undefined => {
  if (matches(error)) return error;
  if (!Runtime.isFiberFailure(error)) return undefined;
  return Array.from(Cause.defects(error[Runtime.FiberFailureCauseId])).find(
    matches,
  );
};

export const getWorkflowError = (error: unknown): WorkflowError | undefined =>
  findError(error, isWorkflowError);

/** Preserve termination failure when a public API would otherwise unwrap abort. */
export const getExecutionTerminationError = (
  error: unknown,
): ExecutionTerminationError | undefined =>
  findError(
    error,
    (value): value is ExecutionTerminationError =>
      value instanceof ExecutionTerminationError,
  );
