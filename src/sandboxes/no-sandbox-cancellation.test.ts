import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { noSandbox } from "./no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;

itPosix(
  "concurrent cancellation waits for kernel process-group reaping",
  async () => {
    for (let batch = 0; batch < 8; batch++) {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, async () => {
          const handle = await noSandbox().create({
            worktreePath: tmpdir(),
            env: {},
          });
          const abort = new AbortController();
          try {
            await expect(
              handle.exec(
                `'${process.execPath}' -e 'console.log("ready"); setTimeout(() => {}, 5000)'`,
                {
                  signal: abort.signal,
                  onLine: () => abort.abort(new Error("reaping probe")),
                },
              ),
            ).rejects.toThrow("reaping probe");
          } finally {
            await handle.close();
          }
        }),
      );
      expect(outcomes.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
    }
  },
  15000,
);

itPosix.each(["abort", "close", "parent-exits"])(
  "%s waits until the invocation's descendants stop writing",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "exec-cancel-"));
    const pids: number[] = [];
    const handle = await noSandbox().create({ worktreePath: dir, env: {} });
    try {
      await writeFile(
        join(dir, "child.cjs"),
        `
      const fs = require('node:fs');
      fs.writeFileSync('heartbeat', 'start');
      setInterval(() => fs.appendFileSync('heartbeat', '.'), 10);
      console.log(process.pid);
      process.send?.('ready');
      setTimeout(() => process.exit(0), 1500);
    `,
      );
      await writeFile(
        join(dir, "parent.cjs"),
        `
      const child = require('node:child_process').spawn(process.execPath, ['child.cjs'], { stdio: ${mode === "parent-exits" ? "['ignore', 'ignore', 'ignore', 'ipc']" : "'inherit'"} });
      ${mode === "parent-exits" ? "child.on('message', () => { console.log(child.pid); child.disconnect(); child.unref(); process.exit(0); });" : ""}
    `,
      );
      const abort = new AbortController();
      let closing: Promise<void> | undefined;
      const execution = handle.exec(`'${process.execPath}' parent.cjs`, {
        ...{ signal: abort.signal },
        onLine: (line) => {
          pids.push(Number(line));
          if (mode === "abort") abort.abort(new Error("test cancellation"));
          else if (mode === "close") {
            closing = handle.close();
            // Observe a concurrent close rejection even if exec fails first.
            void closing.catch(() => {});
          }
        },
      });
      if (mode === "parent-exits") expect((await execution).exitCode).toBe(0);
      else
        await expect(execution).rejects.toThrow(
          mode === "abort" ? "test cancellation" : "Sandbox closed",
        );
      await closing;
      const before = await readFile(join(dir, "heartbeat"), "utf8");
      await delay(100);
      expect(await readFile(join(dir, "heartbeat"), "utf8")).toBe(before);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

itPosix(
  "abort after normal exit leaves a later invocation and its trailing output intact",
  async () => {
    const handle = await noSandbox().create({
      worktreePath: tmpdir(),
      env: {},
    });
    const abort = new AbortController();
    try {
      expect(
        (await handle.exec("printf first", { signal: abort.signal })).stdout,
      ).toBe("first");
      const later = handle.exec("printf start; sleep 0.1; printf tail");
      abort.abort();
      expect((await later).stdout).toBe("starttail");
    } finally {
      await handle.close();
    }
  },
);
