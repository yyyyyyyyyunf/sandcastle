import { gitOutput } from "./gitOutput.js";
import type { Writable } from "node:stream";
import { execOwnedProcess } from "./execOwnedProcess.js";
import { ExecutionTerminationError } from "./processTermination.js";
import { VerificationError, type CandidateContext } from "./Verification.js";

/** Hold Git's ref locks while checking and applying the fast-forward. */
export const mergeVerifiedCandidate = async (
  context: CandidateContext,
  signal?: AbortSignal,
): Promise<void> => {
  const {
    hostRepoDir,
    worktreePath,
    sourceBranch,
    targetBranch,
    candidateCommit,
    targetCommit,
  } = context;
  const sourceRef = `refs/heads/${sourceBranch}`;
  const targetRef = `refs/heads/${targetBranch}`;
  try {
    if (
      (await gitOutput(worktreePath, "status", "--porcelain")) ||
      (await gitOutput(hostRepoDir, "status", "--porcelain"))
    )
      throw new VerificationError(
        "changed",
        "Candidate and target must remain Git-clean through verification",
      );
    await gitOutput(
      hostRepoDir,
      "merge-base",
      "--is-ancestor",
      targetCommit,
      candidateCommit,
    );
  } catch (cause) {
    if (cause instanceof VerificationError) throw cause;
    throw new VerificationError(
      "merge",
      "Checked candidate is not a fast-forward of the target",
      { cause },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new VerificationError("merge", "Verified merge exceeded its deadline"),
      ),
    10000,
  );
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    await withPreparedRefs(
      worktreePath,
      [`verify HEAD ${candidateCommit}`],
      combined,
      async () => {
        if (
          (await gitOutput(worktreePath, "symbolic-ref", "HEAD")) !== sourceRef
        )
          throw new VerificationError(
            "changed",
            "Source branch changed during verification",
          );
        await withPreparedRefs(
          hostRepoDir,
          [`update HEAD ${candidateCommit} ${targetCommit}`],
          combined,
          async () => {
            if (
              (await gitOutput(hostRepoDir, "symbolic-ref", "HEAD")) !==
              targetRef
            )
              throw new VerificationError(
                "changed",
                "Target branch changed during verification",
              );
            const checkout = await execOwnedProcess(
              "git",
              ["read-tree", "-m", "-u", targetCommit, candidateCommit],
              {
                cwd: hostRepoDir,
                env: process.env,
                signal: combined,
              },
            );
            if (checkout.exitCode !== 0)
              throw new VerificationError(
                "merge",
                `Cannot apply checked candidate: ${checkout.stderr}`,
              );
          },
        );
      },
    );
  } finally {
    clearTimeout(timer);
  }
};

const withPreparedRefs = async (
  cwd: string,
  commands: string[],
  signal: AbortSignal,
  work: () => Promise<void>,
): Promise<void> => {
  let input: Writable | undefined;
  let prepared!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  let finished = false;
  const execution = execOwnedProcess(
    "git",
    ["update-ref", "--stdin", "-m", "sandcastle: verified fast-forward"],
    {
      cwd,
      env: process.env,
      signal,
      stdin: (stream) => {
        input = stream;
        stream.write(["start", ...commands, "prepare", ""].join("\n"));
      },
      onLine: (line) => {
        if (line === "prepare: ok") prepared();
      },
    },
  );
  // Observe early process failure while the preparation acknowledgement is pending.
  const earlyExit = execution.then((result) => {
    throw new VerificationError(
      "changed",
      `Cannot lock the checked source and target: ${result.stderr}`,
    );
  });
  void earlyExit.catch(() => {});
  try {
    await Promise.race([preparation, earlyExit]);
    await work();
    input!.end("commit\n");
    const result = await execution;
    finished = true;
    if (result.exitCode !== 0)
      throw new VerificationError(
        "merge",
        `Cannot commit checked target update: ${result.stderr}`,
      );
  } finally {
    if (!finished && input && !input.writableEnded) input.end("abort\n");
    try {
      await execution;
    } catch (error) {
      if (error instanceof ExecutionTerminationError) throw error;
    }
  }
};
