import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { createWorktree } from "./createWorktree.js";
import { createSandbox } from "./createSandbox.js";
import type { AgentProvider } from "./AgentProvider.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each([
  "idle",
  "abort",
  "completion",
  "resists-term",
  "unsupported",
  "unsupported-abort",
  "worktree-unsupported-abort",
  "worktree-sandbox-unsupported-abort",
  "sandbox-unsupported-abort",
  "close-fails",
] as const)(
  "%s stops the real agent descendant before run settles",
  async (mode) => {
    const unsupported = mode.includes("unsupported");
    let resource: { close(): Promise<unknown> } | undefined;
    const dir = await mkdtemp(join(tmpdir(), "run-cancel-"));
    let pid: number | undefined;
    const fixtureCleanup = new AbortController();
    const ownedExecutions: Promise<unknown>[] = [];
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-b", "main");
      await writeFile(
        join(dir, ".gitignore"),
        ".sandcastle/\nheartbeat\npid\n",
      );
      await writeFile(
        join(dir, "child.cjs"),
        `
      const fs = require('node:fs');
      const root = ${JSON.stringify(dir)};
      ${mode === "resists-term" ? "process.on('SIGTERM', () => fs.writeFileSync('term-received', 'yes'));" : ""}
      fs.writeFileSync(root + '/pid', String(process.pid));
      fs.writeFileSync(root + '/heartbeat', 'start');
      setInterval(() => fs.appendFileSync(root + '/heartbeat', '.'), 10);
      ${unsupported ? "fs.writeFileSync('delivery.txt', 'candidate'); require('node:child_process').execFileSync('git', ['add', 'delivery.txt']); require('node:child_process').execFileSync('git', ['commit', '-m', 'candidate']);" : ""}
      console.log(${JSON.stringify(mode === "completion" || unsupported ? "<promise>COMPLETE</promise>" : "ready")});
      setTimeout(() => process.exit(0), ${mode === "close-fails" ? 300 : 10000});
    `,
      );
      await writeFile(
        join(dir, "parent.cjs"),
        `
      require('node:child_process').spawn(process.execPath, ['child.cjs'], { stdio: 'inherit' });
    `,
      );
      git("add", ".");
      git("commit", "-m", "fixture");
      const initialHead = git("rev-parse", "HEAD").toString().trim();
      const abort = new AbortController();
      const agent: AgentProvider = {
        name: "owned-process-fixture",
        env: {},
        captureSessions: false,
        buildPrintCommand: () => ({
          command: `${quote(process.execPath)} parent.cjs`,
        }),
        parseStreamLine: (text) => {
          if (
            mode === "abort" ||
            (mode.endsWith("unsupported-abort") && text.includes("<promise>"))
          )
            abort.abort(new Error("user cancelled fixture"));
          return [{ type: "text", text }];
        },
      };
      const native = noSandbox();
      const sandbox = unsupported
        ? {
            ...native,
            create: async (options: Parameters<typeof native.create>[0]) => {
              const handle = await native.create(options);
              return {
                ...handle,
                supportsExecCancellation: false,
                exec: (
                  command: string,
                  options?: Parameters<typeof handle.exec>[1],
                ) => {
                  const { signal: _signal, ...rest } = options ?? {};
                  const execution = handle.exec(command, {
                    ...rest,
                    signal: fixtureCleanup.signal,
                  });
                  ownedExecutions.push(execution.catch(() => {}));
                  return execution;
                },
              };
            },
          }
        : mode === "close-fails"
          ? {
              ...native,
              create: async (options: Parameters<typeof native.create>[0]) => {
                const handle = await native.create(options);
                return {
                  ...handle,
                  close: async () => {
                    await handle.close();
                    throw new Error("fixture shutdown failed");
                  },
                };
              },
            }
          : native;
      const runOptions = {
        cwd: dir,
        sandbox,
        agent,
        prompt: "fixture",
        branchStrategy:
          mode === "close-fails"
            ? { type: "branch" as const, branch: "candidate" }
            : {
                type: unsupported
                  ? ("merge-to-head" as const)
                  : ("head" as const),
              },
        maxIterations: 1 as const,
        idleTimeoutSeconds: mode === "idle" || mode === "resists-term" ? 1 : 5,
        completionTimeoutSeconds: 0.1,
        signal: abort.signal,
      };
      const execution = mode.startsWith("worktree-")
        ? (async () => {
            const wt = await createWorktree({
              cwd: dir,
              branchStrategy: { type: "merge-to-head" },
            });
            resource = wt;
            if (mode.startsWith("worktree-sandbox-")) {
              const sb = await wt.createSandbox({ sandbox });
              resource = {
                close: async () => {
                  await sb.close();
                  return wt.close();
                },
              };
              return { result: sb.run(runOptions) };
            }
            return { result: wt.run(runOptions) };
          })().then(({ result }) => result)
        : mode.startsWith("sandbox-")
          ? (async () => {
              const sb = await createSandbox({
                cwd: dir,
                sandbox,
                branch: "candidate",
              });
              resource = sb;
              return { result: sb.run(runOptions) };
            })().then(({ result }) => result)
          : run(runOptions);
      if (unsupported || mode === "close-fails") {
        await expect(execution).rejects.toThrow(
          unsupported
            ? "Provider does not support confirmed exec cancellation"
            : "fixture shutdown failed",
        );
        if (resource) await resource.close();
        expect(git("rev-parse", "HEAD").toString().trim()).toBe(initialHead);
        expect(
          git("worktree", "list", "--porcelain")
            .toString()
            .match(/^worktree /gm),
        ).toHaveLength(2);
        return;
      } else if (mode === "completion") {
        expect((await execution).completionSignal).toBe(
          "<promise>COMPLETE</promise>",
        );
      } else {
        await expect(execution).rejects.toThrow(
          mode === "abort" ? "user cancelled fixture" : "Agent idle",
        );
      }
      pid = Number(await readFile(join(dir, "pid"), "utf8"));
      expect(() => process.kill(pid!, 0)).toThrow();
      const before = await readFile(join(dir, "heartbeat"), "utf8");
      await delay(100);
      expect(await readFile(join(dir, "heartbeat"), "utf8")).toBe(before);
      if (mode === "resists-term")
        expect(await readFile(join(dir, "term-received"), "utf8")).toBe("yes");
    } finally {
      fixtureCleanup.abort();
      await resource?.close().catch(() => {});
      await Promise.all(ownedExecutions);
      pid ??= Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* stopped */
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
