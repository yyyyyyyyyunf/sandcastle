import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { run, type RunOptions } from "./run.js";
import type { AgentProvider } from "./AgentProvider.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { createWorktree } from "./createWorktree.js";
import { createSandbox } from "./createSandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function withProcess(
  body: string,
  check: (options: RunOptions) => Promise<unknown>,
) {
  const dir = await mkdtemp(join(tmpdir(), "run-activity-"));
  let pid: number | undefined;
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-b", "main");
    await writeFile(join(dir, ".gitignore"), ".sandcastle/\npid\nheartbeat\n");
    await writeFile(
      join(dir, "agent.cjs"),
      `
      const fs = require('node:fs');
      const root = ${JSON.stringify(dir)};
      fs.writeFileSync(root + '/pid', String(process.pid));
      fs.writeFileSync(root + '/heartbeat', 'start');
      setInterval(() => fs.appendFileSync(root + '/heartbeat', '.'), 20);
      setTimeout(() => process.exit(0), 3000);
      ${body}
    `,
    );
    git("add", ".");
    git("commit", "-m", "fixture");
    const agent: AgentProvider = {
      name: "raw-activity-fixture",
      env: {},
      captureSessions: false,
      buildPrintCommand: () => ({
        command: `${quote(process.execPath)} agent.cjs`,
      }),
      // The transport must observe activity even when parsing yields nothing.
      parseStreamLine: () => [],
    };
    await check({
      cwd: dir,
      sandbox: noSandbox(),
      agent,
      prompt: "fixture",
      maxIterations: 1,
      idleTimeoutSeconds: 0.7,
    });
    pid = Number(await readFile(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid!, 0)).toThrow();
    const heartbeat = await readFile(join(dir, "heartbeat"), "utf8");
    await delay(100);
    expect(await readFile(join(dir, "heartbeat"), "utf8")).toBe(heartbeat);
  } finally {
    pid ??= Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

itPosix.each([
  { name: "stdout without a newline", output: "process.stdout.write('.')" },
  { name: "stderr", output: "process.stderr.write('.')" },
  { name: "unparseable stdout lines", output: "process.stdout.write('.\\n')" },
])("raw $name keeps execution active", async ({ output }) => {
  await withProcess(
    `setInterval(() => ${output}, 100); setTimeout(() => process.exit(0), 1300);`,
    async (options) => {
      const result = await run(options);
      expect(result.iterations).toHaveLength(1);
    },
  );
});

itPosix(
  "continuous stderr cannot renew the absolute execution deadline",
  async () => {
    await withProcess(
      `setInterval(() => process.stderr.write('.'), 100);`,
      async (options) => {
        await expect(
          run({ ...options, executionTimeoutSeconds: 1.3 }),
        ).rejects.toThrow("Agent execution exceeded 1.3 seconds");
      },
    );
  },
);

itPosix(
  "explicit bounded silent execution completes within its budget",
  async () => {
    await withProcess(
      `setTimeout(() => process.exit(0), 900);`,
      async (options) => {
        const result = await run({
          ...options,
          idleTimeoutSeconds: false,
          executionTimeoutSeconds: 2,
        });
        expect(result.iterations).toHaveLength(1);
      },
    );
  },
);

it.each([
  {
    limits: { idleTimeoutSeconds: false as const },
    error: "idleTimeoutSeconds: false requires executionTimeoutSeconds",
  },
  {
    limits: { executionTimeoutSeconds: Infinity },
    error: "executionTimeoutSeconds must be a finite positive number",
  },
  {
    limits: { executionTimeoutSeconds: NaN },
    error: "executionTimeoutSeconds must be a finite positive number",
  },
  {
    limits: { executionTimeoutSeconds: 0 },
    error: "executionTimeoutSeconds must be a finite positive number",
  },
  {
    limits: { idleTimeoutSeconds: -1 },
    error: "idleTimeoutSeconds must be a finite positive number",
  },
  {
    limits: { completionTimeoutSeconds: Infinity },
    error: "completionTimeoutSeconds must be a finite positive number",
  },
  {
    limits: { executionTimeoutSeconds: 2147484 },
    error: "executionTimeoutSeconds must be a finite positive number",
  },
])(
  "rejects invalid limits $limits before allocating a sandbox",
  async ({ limits, error }) => {
    const native = noSandbox();
    const create = vi.fn(async () => {
      throw new Error("unexpected allocation");
    });
    await expect(
      run({
        sandbox: { ...native, create },
        agent: {
          name: "unused",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({ command: "true" }),
          parseStreamLine: () => [],
        },
        prompt: "fixture",
        ...limits,
      }),
    ).rejects.toThrow(error);
    expect(create).not.toHaveBeenCalled();
  },
);

itPosix("completion output cannot extend the absolute deadline", async () => {
  await withProcess(
    `console.log('<promise>COMPLETE</promise>'); setInterval(() => process.stderr.write('.'), 80);`,
    async (options) => {
      await expect(
        run({
          ...options,
          agent: {
            ...options.agent,
            parseStreamLine: (text) => [{ type: "text", text }],
          },
          executionTimeoutSeconds: 0.9,
          completionTimeoutSeconds: 0.3,
        }),
      ).rejects.toThrow("Agent execution exceeded 0.9 seconds");
    },
  );
});

itPosix(
  "idle expiry is distinct from the longer execution deadline",
  async () => {
    await withProcess("", async (options) => {
      await expect(
        run({ ...options, executionTimeoutSeconds: 2 }),
      ).rejects.toThrow("Agent idle for 0.7 seconds");
    });
  },
);

itPosix.each(["run", "worktree", "sandbox"] as const)(
  "%s stops overdue silent execution",
  async (entry) => {
    await withProcess("", async (options) => {
      const limits = {
        idleTimeoutSeconds: false as const,
        executionTimeoutSeconds: 0.9,
      };
      const resource =
        entry === "worktree"
          ? await createWorktree({
              cwd: options.cwd,
              branchStrategy: { type: "merge-to-head" },
            })
          : entry === "sandbox"
            ? await createSandbox({
                cwd: options.cwd,
                sandbox: options.sandbox,
                branch: "candidate",
              })
            : undefined;
      try {
        await expect(
          resource
            ? resource.run({ ...options, ...limits })
            : run({ ...options, ...limits }),
        ).rejects.toThrow("Agent execution exceeded 0.9 seconds");
      } finally {
        await resource?.close();
      }
    });
  },
);
