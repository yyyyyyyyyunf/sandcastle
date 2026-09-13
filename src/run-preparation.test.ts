import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Output } from "./Output.js";
import { run, type RunOptions } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;

itPosix.each(["no-work", "blocked"])(
  "host preparation returns %s without allocating an agent iteration",
  async (decision) => {
    const dir = await mkdtemp(join(tmpdir(), "run-preparation-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir }).toString().trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const head = git("rev-parse", "HEAD");
      let allocations = 0;
      const result = await run({
        cwd: dir,
        prompt: "unused",
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        preparation: {
          command: [
            process.execPath,
            "-e",
            `const fs=require('node:fs'),assert=require('node:assert/strict'); const ctx=JSON.parse(fs.readFileSync(0,'utf8')); assert.equal(ctx.version,1); assert.ok(ctx.iterationId); assert.equal(ctx.targetBranch,'main'); assert.equal(ctx.targetCommit,${JSON.stringify(head)}); console.log(JSON.stringify({version:1,decision:${JSON.stringify(decision)},metadata:{reason:'fixture'}}));`,
          ],
          timeoutSeconds: 5,
        },
        verification: {
          command: [process.execPath, "-e", "process.exit(99)"],
          timeoutSeconds: 5,
        },
        sandbox: {
          ...noSandbox(),
          create: async () => {
            allocations++;
            throw new Error("unexpected allocation");
          },
        },
        agent: {
          name: "unused",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => {
            throw new Error("unexpected agent");
          },
          parseStreamLine: () => [],
        },
      });
      expect(allocations).toBe(0);
      expect(result.stopReason).toBe(decision);
      expect(result.iterations).toEqual([]);
      expect(result.preparation).toMatchObject({
        decision,
        metadata: { reason: "fixture" },
      });
      const record = JSON.parse(await readFile(result.runRecordPath!, "utf8"));
      expect(record.status).toBe("completed");
      expect(record.stopReason).toBe(decision);
      expect(record.iterations).toEqual([]);
      expect(record.preparations).toHaveLength(1);
      expect(record.preparations[0].decision.decision).toBe(decision);
      expect(git("rev-parse", "HEAD")).toBe(head);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

const hostCommand = {
  command: [process.execPath, "-e", ""],
  timeoutSeconds: 5,
};
itPosix.each([
  { preparation: hostCommand },
  { iterationOutput: Output.string({ tag: "r" }) },
  { verification: hostCommand, output: Output.string({ tag: "r" }) },
  {
    verification: hostCommand,
    iterationOutput: Output.string({ tag: "r", maxRetries: 1 }),
  },
  {
    verification: hostCommand,
    preparation: hostCommand,
    resumeSession: "previous",
  },
  { verification: hostCommand, preparation: hostCommand, maxIterations: 0 },
  {
    verification: hostCommand,
    preparation: { ...hostCommand, timeoutSeconds: Infinity },
  },
] satisfies Partial<RunOptions>[])(
  "rejects incompatible native configuration before allocating: %j",
  async (invalid) => {
    let allocations = 0;
    await expect(
      run({
        cwd: tmpdir(),
        prompt: "<r>",
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        sandbox: {
          ...noSandbox(),
          create: async () => {
            allocations++;
            throw new Error("unexpected allocation");
          },
        },
        agent: {
          name: "unused",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({ command: "false" }),
          parseStreamLine: () => [],
        },
        ...invalid,
      }),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(allocations).toBe(0);
  },
);
