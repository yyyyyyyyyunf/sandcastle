export interface AgentTimeouts {
  readonly idleMs: number | undefined;
  readonly executionMs: number | undefined;
  readonly completionMs: number;
}

/** Validate and resolve caller limits before worktree or agent allocation. */
export const resolveAgentTimeouts = (options: {
  idleTimeoutSeconds?: number | false;
  executionTimeoutSeconds?: number;
  completionTimeoutSeconds?: number;
}): AgentTimeouts => {
  if (
    options.idleTimeoutSeconds === false &&
    options.executionTimeoutSeconds === undefined
  ) {
    throw new TypeError(
      "idleTimeoutSeconds: false requires executionTimeoutSeconds",
    );
  }
  for (const key of [
    "idleTimeoutSeconds",
    "executionTimeoutSeconds",
    "completionTimeoutSeconds",
  ] as const) {
    const value = options[key];
    if (
      value === undefined ||
      (key === "idleTimeoutSeconds" && value === false)
    )
      continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value * 1000 > 2_147_483_647
    ) {
      throw new TypeError(
        `${key} must be a finite positive number of seconds no greater than 2147483.647`,
      );
    }
  }
  return {
    idleMs:
      options.idleTimeoutSeconds === false
        ? undefined
        : (options.idleTimeoutSeconds ?? 600) * 1000,
    executionMs:
      options.executionTimeoutSeconds === undefined
        ? undefined
        : options.executionTimeoutSeconds * 1000,
    completionMs: (options.completionTimeoutSeconds ?? 60) * 1000,
  };
};
