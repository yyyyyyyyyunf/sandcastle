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

interface CancellationCase {
  deliver?: boolean;
  name: string;
  entry?: "run" | "worktree" | "sandbox" | "worktree-sandbox";
  stop: "idle" | "abort" | "completion" | "normal";
  unsupported?: boolean;
  resistsTerm?: boolean;
  shutdown?: "fails" | "hangs";
}
const cases: CancellationCase[] = [
  {
    name: "confirmed shutdown merges candidate",
    stop: "normal",
    deliver: true,
  },
  { name: "idle stops descendants", stop: "idle" },
  { name: "abort stops descendants", stop: "abort" },
  { name: "completion grace stops descendants", stop: "completion" },
  {
    name: "SIGTERM resistance requires escalation",
    stop: "idle",
    resistsTerm: true,
  },
  {
    name: "unsupported completion preserves candidate",
    stop: "completion",
    unsupported: true,
  },
  {
    name: "abort does not hide unknown termination",
    stop: "abort",
    unsupported: true,
  },
  {
    name: "worktree run preserves unknown termination",
    entry: "worktree",
    stop: "abort",
    unsupported: true,
  },
  {
    name: "nested sandbox preserves its owning worktree",
    entry: "worktree-sandbox",
    stop: "abort",
    unsupported: true,
  },
  {
    name: "sandbox run preserves unknown termination",
    entry: "sandbox",
    stop: "abort",
    unsupported: true,
  },
  {
    name: "shutdown failure prevents merge",
    stop: "normal",
    shutdown: "fails",
  },
  {
    name: "worktree shutdown failure prevents merge",
    entry: "worktree",
    stop: "normal",
    shutdown: "fails",
  },
  {
    name: "unresponsive shutdown has a deadline and prevents merge",
    stop: "normal",
    shutdown: "hangs",
  },
];
itPosix.each(cases)(
  "$name",
  async ({
    entry = "run",
    stop,
    unsupported = false,
    resistsTerm = false,
    shutdown,
    deliver = false,
  }) => {
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
      ${resistsTerm ? "process.on('SIGTERM', () => fs.writeFileSync('term-received', 'yes'));" : ""}
      fs.writeFileSync(root + '/pid', String(process.pid));
      fs.writeFileSync(root + '/heartbeat', 'start');
      setInterval(() => fs.appendFileSync(root + '/heartbeat', '.'), 10);
      ${unsupported || shutdown !== undefined || deliver ? "fs.writeFileSync('delivery.txt', 'candidate'); require('node:child_process').execFileSync('git', ['add', 'delivery.txt']); require('node:child_process').execFileSync('git', ['commit', '-m', 'candidate']);" : ""}
      console.log(${JSON.stringify(stop === "completion" || unsupported ? "<promise>COMPLETE</promise>" : "ready")});
      setTimeout(() => process.exit(0), ${shutdown !== undefined || deliver ? 300 : 10000});
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
          if (stop === "abort" && (!unsupported || text.includes("<promise>")))
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
        : shutdown !== undefined
          ? {
              ...native,
              create: async (options: Parameters<typeof native.create>[0]) => {
                const handle = await native.create(options);
                return {
                  ...handle,
                  close: async () => {
                    await handle.close();
                    if (shutdown === "fails")
                      throw new Error("fixture shutdown failed");
                    await new Promise<void>(() => {});
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
        branchStrategy: {
          type:
            unsupported || shutdown !== undefined || deliver
              ? ("merge-to-head" as const)
              : ("head" as const),
        },
        maxIterations: 1 as const,
        idleTimeoutSeconds: stop === "idle" || resistsTerm ? 1 : 5,
        completionTimeoutSeconds: 0.1,
        signal: abort.signal,
      };
      const execution =
        entry === "worktree" || entry === "worktree-sandbox"
          ? (async () => {
              const wt = await createWorktree({
                cwd: dir,
                branchStrategy: { type: "merge-to-head" },
              });
              resource = wt;
              if (entry === "worktree-sandbox") {
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
          : entry === "sandbox"
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
      if (unsupported || shutdown !== undefined) {
        await expect(execution).rejects.toThrow(
          unsupported
            ? "Provider does not support confirmed exec cancellation"
            : shutdown === "fails"
              ? "fixture shutdown failed"
              : "Shutdown did not finish within 7 seconds",
        );
        if (resource) await resource.close();
        expect(git("rev-parse", "HEAD").toString().trim()).toBe(initialHead);
        expect(
          git("worktree", "list", "--porcelain")
            .toString()
            .match(/^worktree /gm),
        ).toHaveLength(2);
        return;
      } else if (deliver) {
        expect((await execution).commits).toHaveLength(1);
        expect(git("rev-parse", "HEAD").toString().trim()).not.toBe(
          initialHead,
        );
        expect(await readFile(join(dir, "delivery.txt"), "utf8")).toBe(
          "candidate",
        );
      } else if (stop === "completion") {
        expect((await execution).completionSignal).toBe(
          "<promise>COMPLETE</promise>",
        );
      } else {
        await expect(execution).rejects.toThrow(
          stop === "abort" ? "user cancelled fixture" : "Agent idle",
        );
      }
      pid = Number(await readFile(join(dir, "pid"), "utf8"));
      expect(() => process.kill(pid!, 0)).toThrow();
      const before = await readFile(join(dir, "heartbeat"), "utf8");
      await delay(100);
      expect(await readFile(join(dir, "heartbeat"), "utf8")).toBe(before);
      if (resistsTerm)
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
  15000,
);
