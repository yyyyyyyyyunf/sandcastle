import { PreparationError, assertPreparedTarget } from "./Preparation.js";
import { extractStructuredOutput } from "./extractStructuredOutput.js";
import type { OutputDefinition } from "./Output.js";
import {
  substitutePromptArgs,
  BUILT_IN_PROMPT_ARG_KEYS,
  type PromptArgs,
} from "./PromptArgumentSubstitution.js";
import { randomUUID } from "node:crypto";
import { gitOutput } from "./gitOutput.js";
import {
  prepareIteration,
  type PreparationOptions,
  type PreparationDecision,
  type PreparationContext,
  type RunStopReason,
} from "./Preparation.js";
import { ExecutionTerminationError } from "./processTermination.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  verifyCandidate,
  type VerificationOptions,
  type VerificationDecision,
} from "./Verification.js";
import { RunJournal } from "./RunJournal.js";
import type { ArtifactStore } from "./Artifacts.js";
import {
  createRunRecovery,
  recordPreservedWorktree,
  type RunRecovery,
} from "./RunRecovery.js";
import { resolveAgentTimeouts, type AgentTimeouts } from "./agentTimeouts.js";
import { Cause, Deferred, Duration, Effect, Exit, Fiber } from "effect";
import { AgentStreamEmitter } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  AgentExecutionTimeoutError,
  SessionCaptureError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider, IterationUsage } from "./AgentProvider.js";
import type { Timeouts } from "./run.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";

export type { ParsedStreamEvent, IterationUsage } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  timeouts: AgentTimeouts,
  completionSignals: readonly string[],
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onRawLine: (line: string) => void,
  onIdleWarning: (minutes: number) => void,
  onCompletionTimeout: (timeoutMs: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
  resumeSession?: string,
  forkSession?: boolean,
  signal?: AbortSignal,
  captureFullOutput = false,
): Effect.Effect<
  {
    result: string;
    rawStdout?: string;
    sessionId?: string;
    usage?: IterationUsage;
  },
  SandboxError
> =>
  Effect.gen(function* () {
    const {
      idleMs: idleTimeoutMs,
      executionMs: executionTimeoutMs,
      completionMs: completionTimeoutMs,
    } = timeouts;
    let resultText = "";
    let sessionId: string | undefined;
    let usage: IterationUsage | undefined;
    // Accumulated text/result output, scanned for the completion signal so a
    // hanging process can be force-completed once the signal is in the buffer
    // (see ADR 0019).
    let accumulatedOutput = "";
    const rawLines: string[] = [];
    let rawLength = 0;
    const fullOutput = () => {
      return rawLines.join("\n");
    };

    // Deferred that fails when the idle timer fires (no signal seen).
    const executionFailure = yield* Deferred.make<
      never,
      AgentIdleTimeoutError | AgentError
    >();
    const outputLimitError = () =>
      new AgentError({
        message:
          "Guarded iteration output exceeded 16 MiB; verification cannot use a truncated result",
      });
    // Request termination without freezing output. TERM handlers may still
    // emit result/session/usage data before the invocation actually stops.
    const completionTimeoutDeferred = yield* Deferred.make<
      { completionTimedOut: true },
      never
    >();
    let timeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let completionDetected = false;

    // Periodic idle warning state
    let warningFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let idleMinuteCounter = 0;

    const interruptFiber = (
      fiber: Fiber.RuntimeFiber<unknown, unknown> | null,
    ) => {
      if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    };

    const startWarningInterval = () => {
      interruptFiber(warningFiber);
      idleMinuteCounter = 0;
      warningFiber = Effect.runFork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(idleWarningIntervalMs));
            idleMinuteCounter++;
            onIdleWarning(idleMinuteCounter);
          }
        }),
      );
    };

    const resetTimer = () => {
      interruptFiber(timeoutFiber);
      if (completionDetected) {
        // Post-signal grace window — successful resolution on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(completionTimeoutMs));
            onCompletionTimeout(completionTimeoutMs);
            yield* Deferred.succeed(completionTimeoutDeferred, {
              completionTimedOut: true as const,
            });
          }),
        );
      } else if (idleTimeoutMs !== undefined) {
        // Pre-signal idle window — failure on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            yield* Deferred.fail(
              executionFailure,
              new AgentIdleTimeoutError({
                message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
                timeoutMs: idleTimeoutMs,
              }),
            );
          }),
        );
        // Reset warning interval on activity, idle-phase only.
        startWarningInterval();
      }
    };

    // Deferred that will be resolved (as a defect) when the AbortSignal fires.
    // Uses Effect.die so the abort reason propagates as-is to run().
    const abortDeferred = yield* Deferred.make<never, never>();
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        return yield* Effect.die(signal.reason);
      }
      const onAbort = () => {
        Effect.runFork(Deferred.die(abortDeferred, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    resetTimer();

    const execEffect = Effect.gen(function* () {
      const printCmd = provider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
        forkSession,
      });
      const execResult = yield* sandbox.exec(printCmd.command, {
        onActivity: resetTimer,
        onLine: (line) => {
          if (captureFullOutput) {
            rawLength += Buffer.byteLength(line) + 1;
            if (rawLength > 16 * 1024 * 1024) {
              Effect.runFork(
                Deferred.fail(executionFailure, outputLimitError()),
              );
              return;
            }
            rawLines.push(line);
          }
          // Surface the raw line FIRST so verbose mode/forwarders see every
          // stdout line the agent produced, including ones parseStreamLine
          // drops. Errors thrown by the callback are caught by the emitter
          // layer; isolate the parser path here so a broken forwarder cannot
          // skip parsing.
          try {
            onRawLine(line);
          } catch {
            // Swallow — must not skip parsing/timer logic below.
          }
          for (const parsed of provider.parseStreamLine(line)) {
            if (parsed.type === "text") {
              onText(parsed.text);
              accumulatedOutput += parsed.text;
            } else if (parsed.type === "result") {
              resultText = parsed.result;
              accumulatedOutput += parsed.result;
            } else if (parsed.type === "tool_call") {
              onToolCall(parsed.name, parsed.args);
            } else if (parsed.type === "session_id") {
              sessionId = parsed.sessionId;
            } else if (parsed.type === "usage") {
              usage = parsed.usage;
            }
          }
          // Check for the completion signal AFTER parsing this line so the
          // accumulator contains everything seen so far. Flip to the
          // completion-grace timer the first time the signal appears.
          if (
            !completionDetected &&
            completionSignals.some((sig) => accumulatedOutput.includes(sig))
          ) {
            completionDetected = true;
            interruptFiber(warningFiber);
            warningFiber = null;
          }
          resetTimer();
        },
        cwd: sandboxRepoDir,
        stdin: printCmd.stdin,
      });

      if (execResult.exitCode !== 0) {
        // Prefer stderr; fall back to resultText (from parsed stream events),
        // then to the tail of raw stdout (last 20 non-empty lines).
        let errorDetail = execResult.stderr;
        if (!errorDetail.trim()) {
          errorDetail = resultText;
        }
        if (!errorDetail.trim()) {
          const lines = execResult.stdout.split("\n").filter((l) => l.trim());
          errorDetail = lines.slice(-20).join("\n");
        }
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}:\n${errorDetail}`,
          }),
        );
      }

      const rawStdout = captureFullOutput ? fullOutput() : undefined;
      return {
        result:
          resultText ||
          (captureFullOutput
            ? accumulatedOutput || rawStdout!
            : execResult.stdout),
        rawStdout,
        sessionId,
        usage,
      };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );

    let raced: Effect.Effect<
      | {
          result: string;
          rawStdout?: string;
          sessionId?: string;
          usage?: IterationUsage;
        }
      | { completionTimedOut: true },
      AgentIdleTimeoutError | SandboxError
    > = Effect.raceFirst(execEffect, Deferred.await(executionFailure));
    raced = Effect.raceFirst(raced, Deferred.await(completionTimeoutDeferred));
    if (executionTimeoutMs !== undefined) {
      raced = Effect.raceFirst(
        raced,
        Effect.sleep(Duration.millis(executionTimeoutMs)).pipe(
          Effect.zipRight(
            Effect.fail(
              new AgentExecutionTimeoutError({
                message: `Agent execution exceeded ${executionTimeoutMs / 1000} seconds — the fixed execution deadline expired.`,
                timeoutMs: executionTimeoutMs,
              }),
            ),
          ),
        ),
      );
    }
    if (signal) {
      raced = Effect.raceFirst(
        raced,
        Deferred.await(abortDeferred) as Effect.Effect<never, never>,
      );
    }

    const outcome = yield* raced.pipe(
      Effect.ensuring(sandbox.assertExecStopped?.() ?? Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          abortCleanup?.();
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );
    if (rawLength > 16 * 1024 * 1024)
      return yield* Effect.fail(outputLimitError());
    return "completionTimedOut" in outcome
      ? {
          result:
            resultText ||
            accumulatedOutput ||
            (captureFullOutput ? fullOutput() : ""),
          rawStdout: captureFullOutput ? fullOutput() : undefined,
          sessionId,
          usage,
        }
      : outcome;
  });

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

export interface OrchestrateOptions {
  readonly preparation?: PreparationOptions;
  readonly iterationOutput?: OutputDefinition;
  readonly promptTemplate?: { text: string; args: PromptArgs };
  readonly verification?: VerificationOptions;
  readonly onRetainWorktree?: (path: string) => void;
  readonly artifactStore?: ArtifactStore;
  readonly recovery?: RunRecovery;
  readonly hostRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with AgentIdleTimeoutError. Default: 600 (10 minutes) */
  /** Set false for silent tools only with a finite executionTimeoutSeconds. */
  readonly idleTimeoutSeconds?: number | false;
  /** Fixed deadline per agent invocation in seconds; output never renews it. */
  readonly executionTimeoutSeconds?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (because a spawned child is keeping
   * stdout open — see ADR 0019), this timer requests termination. Only after
   * confirmed termination can the iteration return buffered output. Resets on every subsequent stdout/stderr activity, so trailing data (token-usage events, terminal `result` events,
   * structured-output tags) is still captured. Default: 60 seconds.
   */
  readonly completionTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it — the parent JSONL stays intact and the agent writes a new session
   * under a fresh id. Applied to iteration 1 only. See ADR 0018.
   */
  readonly forkSession?: boolean;
  /** An AbortSignal that cancels the orchestration when aborted. */
  readonly signal?: AbortSignal;
  /** When true, skip prompt expansion (shell expression evaluation). Set for dynamic inline prompts. */
  readonly skipPromptExpansion?: boolean;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** Forwarded to `withSandboxLifecycle` — see `SandboxLifecycleOptions.keepSourceBranch`. */
  readonly keepSourceBranch?: boolean;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  readonly metadata?: unknown;
  readonly output?: unknown;
  readonly rawResultPath?: string;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly targetCommit?: string;
  readonly candidateCommit?: string;
  readonly mergedCommit?: string;
  readonly commits?: { sha: string }[];
  readonly iterationId?: string;
  readonly verification?: VerificationDecision;
  readonly resultPath?: string;
  readonly artifactRoot?: string;
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
  /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
  readonly usage?: IterationUsage;
}

export interface OrchestrateResult {
  readonly stopReason?: RunStopReason;
  readonly preparation?: PreparationDecision;
  readonly runRecordPath?: string;
  readonly artifactRoot?: string;
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Most recently preserved worktree, including when a later iteration was clean. */
  readonly preservedWorktreePath?: string;
  /** All worktrees preserved by this run, in iteration order. */
  readonly preservedWorktreePaths: string[];
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<
  OrchestrateResult,
  SandboxError,
  SandboxFactory | Display | AgentStreamEmitter
> => {
  const agentTimeouts = resolveAgentTimeouts(options);
  const recovery = options.recovery ?? createRunRecovery();
  const journal = options.artifactStore
    ? new RunJournal(options.artifactStore)
    : undefined;
  recovery.runRecordPath = journal?.path;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } =
      options;
    let completionSignals: string[];
    if (options.completionSignal === undefined) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    const allIterations = recovery.iterations;
    let allStdout = "";
    let resolvedBranch = "";
    const preservedWorktreePaths = recovery.preservedWorktreePaths;

    // Helper: check abort signal and bail via defect so run() can
    // re-throw the signal's reason verbatim (no Sandcastle wrapping).
    const checkAbort = (): Effect.Effect<void> =>
      options.signal?.aborted ? Effect.die(options.signal.reason) : Effect.void;

    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      let preparedContext: PreparationContext | undefined;
      let preparation: PreparationDecision | undefined;
      if (options.preparation) {
        preparedContext = {
          version: 1,
          iterationId: randomUUID(),
          hostRepoDir,
          targetBranch: yield* Effect.promise(() =>
            gitOutput(hostRepoDir, "symbolic-ref", "--short", "HEAD"),
          ),
          targetCommit: yield* Effect.promise(() =>
            gitOutput(hostRepoDir, "rev-parse", "HEAD"),
          ),
        };
        const context = preparedContext;
        yield* Effect.promise(() => journal!.preparing(context));
        preparation = yield* Effect.promise(() =>
          prepareIteration(options.preparation!, context, options.signal),
        );
        const decision = preparation;
        yield* Effect.promise(() => journal!.prepared(context, decision));
        if (decision.decision !== "run")
          return {
            stopReason: decision.decision,
            preparation: decision,
            artifactRoot: options.artifactStore?.root,
            runRecordPath: journal?.path,
            iterations: allIterations,
            stdout: allStdout,
            commits: allCommits,
            branch: resolvedBranch || context.targetBranch,
            preservedWorktreePaths,
            preservedWorktreePath: preservedWorktreePaths.at(-1),
          };
        yield* Effect.promise(() => assertPreparedTarget(context));
      }
      const attempt = journal
        ? yield* Effect.promise(() =>
            journal.begin(
              i,
              preparedContext?.iterationId,
              preparation?.metadata,
            ),
          )
        : undefined;
      const artifactRoot = attempt?.artifactRoot;
      let resultPath: string | undefined;
      let rawResultPath: string | undefined;
      let extractedOutput: unknown;
      const sandboxResult = yield* factory.withSandbox(
        (
          {
            hostWorktreePath,
            sandboxRepoPath,
            applyToHost,
            bindMountHandle,
            finalizeSandbox,
          },
          sandbox,
        ) =>
          Effect.gen(function* () {
            if (journal && attempt)
              yield* Effect.promise(() =>
                journal.allocated(attempt, hostWorktreePath ?? sandboxRepoPath),
              );
            const value = yield* withSandboxLifecycle(
              {
                hostRepoDir,
                sandboxRepoDir: sandboxRepoPath,
                hooks,
                branch,
                hostWorktreePath,
                applyToHost,
                finalizeSandbox,
                preserveArtifacts:
                  journal && attempt
                    ? (worktree) => journal.capture(attempt, worktree)
                    : undefined,
                verifyCandidate:
                  options.verification && journal && attempt
                    ? async (candidate, result) => {
                        rawResultPath = join(
                          options.artifactStore!.root,
                          `${attempt.iterationId}.raw.json`,
                        );
                        const raw = result as {
                          stdout: string;
                          sessionId?: string;
                          sessionFilePath?: string;
                        };
                        const boundResult = {
                          ...raw,
                          ...candidate,
                          iterationId: attempt.iterationId,
                          metadata: preparation?.metadata,
                        };
                        await writeFile(
                          rawResultPath,
                          JSON.stringify(boundResult) + "\n",
                          { flag: "wx" },
                        );
                        await journal.result(attempt, {
                          ...candidate,
                          rawResultPath,
                        });
                        if (options.iterationOutput)
                          extractedOutput = await extractStructuredOutput(
                            raw.stdout,
                            options.iterationOutput,
                            {
                              commits: [],
                              branch: candidate.sourceBranch,
                              preservedWorktreePath: candidate.worktreePath,
                              sessionId: raw.sessionId,
                              sessionFilePath: raw.sessionFilePath,
                            },
                          );
                        resultPath = join(
                          options.artifactStore!.root,
                          `${attempt.iterationId}.result.json`,
                        );
                        await writeFile(
                          resultPath,
                          JSON.stringify({
                            ...boundResult,
                            output: extractedOutput,
                          }) + "\n",
                          { flag: "wx" },
                        );
                        await journal.result(attempt, {
                          ...candidate,
                          rawResultPath,
                          resultPath,
                          output: extractedOutput,
                        });
                        const context = {
                          ...candidate,
                          version: 1 as const,
                          iterationId: attempt.iterationId,
                          metadata: preparation?.metadata,
                          artifactRoot: attempt.artifactRoot,
                          resultPath,
                        };
                        const decision = await verifyCandidate(
                          options.verification!,
                          context,
                          options.signal,
                        );
                        await journal.verified(attempt, context, decision);
                        if (decision.decision === "retain") {
                          recordPreservedWorktree(
                            recovery,
                            candidate.worktreePath,
                          );
                          options.onRetainWorktree?.(candidate.worktreePath);
                        }
                        return decision;
                      }
                    : undefined,
                signal: options.signal,
                timeouts: options.timeouts,
                keepSourceBranch: options.keepSourceBranch,
              },
              sandbox,
              (ctx) =>
                Effect.gen(function* () {
                  // Resume session: transfer JSONL from host to sandbox before iteration 1
                  const iterationResumeSession =
                    i === 1 ? options.resumeSession : undefined;
                  const iterationForkSession =
                    i === 1 ? options.forkSession : undefined;
                  if (
                    iterationResumeSession &&
                    bindMountHandle &&
                    provider.sessionStorage
                  ) {
                    yield* display.status(label("Resuming session"), "info");
                    yield* Effect.tryPromise({
                      try: () =>
                        provider.sessionStorage!.resumeIntoSandbox({
                          hostCwd: hostRepoDir,
                          sandboxCwd: ctx.sandboxRepoDir,
                          sessionId: iterationResumeSession,
                          handle: bindMountHandle,
                        }),
                      catch: (e) =>
                        new SessionCaptureError({
                          message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                          sessionId: iterationResumeSession,
                        }),
                    });
                  }

                  // Preprocess prompt (run !`command` expressions inside sandbox).
                  // Inline prompts pass through literally — skip expansion.
                  let iterationPrompt = prompt;
                  let handoff:
                    | (PreparationContext & {
                        sourceBranch: string;
                        worktreePath: string;
                      })
                    | undefined;
                  if (options.preparation || options.iterationOutput) {
                    const identity = yield* Effect.promise(async () => {
                      const worktreePath =
                        hostWorktreePath ?? ctx.sandboxRepoDir;
                      const sourceBranch = await gitOutput(
                        worktreePath,
                        "symbolic-ref",
                        "--short",
                        "HEAD",
                      );
                      const targetBranch =
                        preparedContext?.targetBranch ?? ctx.targetBranch!;
                      const targetCommit =
                        preparedContext?.targetCommit ?? ctx.targetCommit!;
                      if (ctx.baseHead !== targetCommit)
                        throw new PreparationError(
                          "changed",
                          "Prepared target or source baseline changed before agent invocation",
                        );
                      return {
                        version: 1 as const,
                        hostRepoDir,
                        iterationId: attempt!.iterationId,
                        metadata: preparation?.metadata,
                        sourceBranch,
                        targetBranch,
                        targetCommit,
                        worktreePath,
                        sandboxRepoDir: ctx.sandboxRepoDir,
                        artifactRoot,
                        outputTag: options.iterationOutput?.tag,
                      };
                    });
                    handoff = identity;
                    if (options.promptTemplate)
                      iterationPrompt = yield* substitutePromptArgs(
                        options.promptTemplate.text,
                        {
                          ...options.promptTemplate.args,
                          SOURCE_BRANCH: identity.sourceBranch,
                          TARGET_BRANCH: identity.targetBranch,
                        },
                        new Set<string>(BUILT_IN_PROMPT_ARG_KEYS),
                      );
                  }
                  let fullPrompt = options.skipPromptExpansion
                    ? iterationPrompt
                    : yield* preprocessPrompt(
                        iterationPrompt,
                        ctx.sandbox,
                        ctx.sandboxRepoDir,
                      );
                  if (handoff) {
                    const context = handoff;
                    yield* Effect.promise(async () => {
                      await assertPreparedTarget(context);
                      if (
                        (await gitOutput(
                          context.worktreePath,
                          "rev-parse",
                          "HEAD",
                        )) !== context.targetCommit ||
                        (await gitOutput(
                          context.worktreePath,
                          "symbolic-ref",
                          "--short",
                          "HEAD",
                        )) !== context.sourceBranch
                      )
                        throw new PreparationError(
                          "changed",
                          "Source baseline changed during prompt preparation",
                        );
                    });
                    fullPrompt +=
                      "\n\n<sandcastle-iteration-context>\n" +
                      JSON.stringify(handoff).replaceAll("<", "\\u003c") +
                      "\n</sandcastle-iteration-context>";
                  }

                  yield* display.status(label("Agent started"), "success");

                  // Invoke the agent — buffer text deltas so Pi's single-token
                  // chunks are displayed as readable multi-word lines.
                  const textBuffer = new TextDeltaBuffer((chunk) => {
                    Effect.runPromise(display.textChunk(chunk));
                    Effect.runPromise(
                      streamEmitter.emit({
                        type: "text",
                        message: chunk,
                        iteration: i,
                        timestamp: new Date(),
                      }),
                    );
                  });
                  const onText = (text: string) => {
                    textBuffer.write(text);
                  };
                  const onToolCall = (name: string, formattedArgs: string) => {
                    textBuffer.flush();
                    Effect.runPromise(display.toolCall(name, formattedArgs));
                    Effect.runPromise(
                      streamEmitter.emit({
                        type: "toolCall",
                        name,
                        formattedArgs,
                        iteration: i,
                        timestamp: new Date(),
                      }),
                    );
                  };
                  const onRawLine = (line: string) => {
                    Effect.runPromise(
                      streamEmitter.emit({
                        type: "raw",
                        line,
                        iteration: i,
                        timestamp: new Date(),
                      }),
                    );
                  };
                  const onIdleWarning = (minutes: number) => {
                    const msg =
                      minutes === 1
                        ? "Agent idle for 1 minute"
                        : `Agent idle for ${minutes} minutes`;
                    Effect.runPromise(display.status(label(msg), "warn"));
                  };
                  const onCompletionTimeout = (timeoutMs: number) => {
                    Effect.runPromise(
                      display.status(
                        label(
                          `Completion signal seen but agent process is hanging — requesting termination after ${timeoutMs / 1000}s grace window.`,
                        ),
                        "warn",
                      ),
                    );
                  };
                  const {
                    result: agentOutput,
                    rawStdout,
                    sessionId,
                    usage: streamUsage,
                  } = yield* invokeAgent(
                    ctx.sandbox,
                    ctx.sandboxRepoDir,
                    fullPrompt,
                    provider,
                    agentTimeouts,
                    completionSignals,
                    onText,
                    onToolCall,
                    onRawLine,
                    onIdleWarning,
                    onCompletionTimeout,
                    options._idleWarningIntervalMs,
                    iterationResumeSession,
                    iterationForkSession,
                    options.signal,
                    options.verification !== undefined,
                  );

                  // Flush any remaining buffered text deltas
                  textBuffer.dispose();

                  yield* display.status(label("Agent stopped"), "info");

                  // Capture session while sandbox is still alive. Usage from the
                  // stream (e.g. Codex's turn.completed) is the baseline; a
                  // session-parsed value below overrides it when available.
                  let sessionFilePath: string | undefined;
                  let usage: IterationUsage | undefined = streamUsage;
                  if (
                    provider.captureSessions &&
                    provider.sessionStorage &&
                    sessionId &&
                    bindMountHandle
                  ) {
                    yield* display.status(label("Capturing session"), "info");
                    yield* Effect.tryPromise({
                      try: () =>
                        provider.sessionStorage!.captureToHost({
                          hostCwd: hostRepoDir,
                          sandboxCwd: ctx.sandboxRepoDir,
                          sessionId,
                          handle: bindMountHandle,
                        }),
                      catch: (e) =>
                        new SessionCaptureError({
                          message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                          sessionId,
                        }),
                    });
                    sessionFilePath =
                      provider.sessionStorage.hostSessionFilePath(
                        hostRepoDir,
                        sessionId,
                      );

                    // Parse token usage from the captured session JSONL
                    if (provider.parseSessionUsage) {
                      const content = yield* Effect.promise(() =>
                        provider
                          .sessionStorage!.readHostSession(
                            hostRepoDir,
                            sessionId,
                          )
                          .catch(() => undefined as string | undefined),
                      );
                      if (content) {
                        const parsedUsage = provider.parseSessionUsage(content);
                        if (parsedUsage) usage = parsedUsage;
                      }
                    }
                  }

                  // Check completion signal
                  const matchedSignal = completionSignals.find((sig) =>
                    agentOutput.includes(sig),
                  );
                  return {
                    completionSignal: matchedSignal,
                    stdout: agentOutput,
                    rawStdout,
                    sessionId,
                    sessionFilePath,
                    usage,
                  } as const;
                }),
            );
            if (journal && attempt)
              yield* Effect.promise(() =>
                journal.beforeCleanup(attempt, value),
              );
            return value;
          }),
      );

      const lifecycleResult = sandboxResult.value;
      if (sandboxResult.preservedWorktreePath)
        recordPreservedWorktree(recovery, sandboxResult.preservedWorktreePath);

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      allIterations.push({
        iterationId: attempt?.iterationId,
        metadata: preparation?.metadata,
        output: extractedOutput,
        rawResultPath,
        sourceBranch: attempt?.sourceBranch,
        targetBranch: attempt?.targetBranch,
        targetCommit: attempt?.targetCommit,
        candidateCommit: attempt?.candidateCommit,
        mergedCommit: lifecycleResult.mergedCommit,
        commits: lifecycleResult.commits,
        verification: lifecycleResult.verification,
        resultPath,
        artifactRoot,
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
        usage: lifecycleResult.result.usage,
      });

      if (journal && attempt)
        yield* Effect.promise(() =>
          journal.completed(attempt, preservedWorktreePaths),
        );

      if (
        lifecycleResult.verification?.decision === "retain" ||
        (!options.preparation &&
          lifecycleResult.result.completionSignal !== undefined)
      ) {
        yield* display.status(
          label(
            lifecycleResult.verification?.decision === "retain"
              ? `Verification retained iteration ${i}; stopping.`
              : `Agent signaled completion after ${i} iteration(s).`,
          ),
          lifecycleResult.verification?.decision === "retain"
            ? "warn"
            : "success",
        );
        return {
          stopReason:
            lifecycleResult.verification?.decision === "retain"
              ? ("retained" as const)
              : undefined,
          artifactRoot: options.artifactStore?.root,
          runRecordPath: journal?.path,
          iterations: allIterations,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: preservedWorktreePaths.at(-1),
          preservedWorktreePaths,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    return {
      stopReason: options.preparation
        ? ("iteration-limit" as const)
        : undefined,
      artifactRoot: options.artifactStore?.root,
      runRecordPath: journal?.path,
      iterations: allIterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: preservedWorktreePaths.at(-1),
      preservedWorktreePaths,
    };
  }).pipe(
    Effect.onExit((exit) =>
      journal
        ? Effect.promise(() =>
            journal.finish(
              Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
              recovery.preservedWorktreePaths,
              Exit.isFailure(exit) &&
                Array.from(Cause.defects(exit.cause)).some(
                  (error) => error instanceof ExecutionTerminationError,
                ),
              Exit.isSuccess(exit) ? exit.value.stopReason : undefined,
            ),
          )
        : Effect.void,
    ),
  );
};
