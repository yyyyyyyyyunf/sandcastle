import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import type { ExecOptions } from "./SandboxProvider.js";

it("activity resets idle without moving the original execution deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deadline-clock-"));
  const abort = new AbortController();
  let execution: Promise<unknown> | undefined;
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-b", "main");
    await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
    git("add", ".");
    git("commit", "-m", "fixture");
    const native = noSandbox();
    let activity: ExecOptions["onActivity"];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const sandbox = {
      ...native,
      create: async (options: Parameters<typeof native.create>[0]) => {
        const handle = await native.create(options);
        return {
          ...handle,
          supportsExecCancellation: true,
          exec: (command: string, options?: ExecOptions) => {
            if (command !== "controlled-agent")
              return handle.exec(command, options);
            activity = options?.onActivity;
            ready();
            return new Promise<never>((_, reject) =>
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal!.reason),
                { once: true },
              ),
            );
          },
        };
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    execution = run({
      cwd: dir,
      sandbox,
      prompt: "fixture",
      signal: abort.signal,
      agent: {
        name: "clock",
        env: {},
        captureSessions: false,
        buildPrintCommand: () => ({ command: "controlled-agent" }),
        parseStreamLine: () => [],
      },
      idleTimeoutSeconds: 1,
      executionTimeoutSeconds: 2.5,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await started;
    for (const step of [500, 500, 500, 500, 499]) {
      await vi.advanceTimersByTimeAsync(step);
      activity!();
      expect(settled).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await execution)).toContain(
      "Agent execution exceeded 2.5 seconds",
    );
  } finally {
    abort.abort(new Error("fixture cleanup"));
    vi.useRealTimers();
    await execution;
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
