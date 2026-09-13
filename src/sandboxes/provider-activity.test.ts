import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { docker } from "./docker.js";
import { podman } from "./podman.js";
import { daytona } from "./daytona.js";
import { vercel } from "./vercel.js";
import type { Writable } from "node:stream";

const sdk = vi.hoisted(() => ({ logs: vi.fn(), runCommand: vi.fn() }));
vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    async create() {
      return {
        getWorkDir: async () => "/fixture",
        process: {
          createSession: async () => {},
          executeSessionCommand: async () => ({ cmdId: "fixture" }),
          getSessionCommandLogs: sdk.logs,
          getSessionCommand: async () => ({ exitCode: 0 }),
          deleteSession: async () => {},
        },
      };
    }
    async delete() {}
  },
}));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: async () => ({
      mkDir: async () => {},
      runCommand: sdk.runCommand,
      stop: async () => {},
    }),
  },
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

it.each([
  { name: "docker", factory: docker },
  { name: "podman", factory: podman },
])(
  "$name reports raw stdout and stderr activity before line delivery",
  async ({ factory }) => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: unknown,
      args: string[],
      ...rest: unknown[]
    ) => {
      const callback = rest.at(-1) as (...args: unknown[]) => void;
      callback(null, args[0] === "machine" ? '[{"Running":true}]' : "", "");
    }) as typeof execFile);
    const process = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValue(process as ReturnType<typeof spawn>);
    const handle = await factory().create({
      worktreePath: "/tmp/fixture",
      hostRepoPath: "/tmp/fixture",
      mounts: [],
      env: {},
    });
    const activity = vi.fn();
    const lines = vi.fn();
    try {
      const execution = handle.exec("fixture", {
        onActivity: activity,
        onLine: lines,
      });
      process.stdout.write("partial");
      expect(activity).toHaveBeenCalledTimes(1);
      expect(lines).not.toHaveBeenCalled();
      process.stderr.write("warning");
      expect(activity).toHaveBeenCalledTimes(2);
      process.stdout.end("\n");
      process.stderr.end();
      process.emit("close", 0);
      expect(await execution).toMatchObject({
        stdout: "partial",
        stderr: "warning",
        exitCode: 0,
      });
    } finally {
      await handle.close();
    }
  },
);

it.each([
  { name: "daytona", factory: daytona },
  { name: "vercel", factory: vercel },
])(
  "$name reports raw SDK output activity before line delivery",
  async ({ factory }) => {
    const activity = vi.fn();
    const lines = vi.fn();
    const emit = (
      stdout: (text: string) => void,
      stderr: (text: string) => void,
    ) => {
      stdout("");
      stderr("");
      expect(activity).not.toHaveBeenCalled();
      stdout("partial");
      expect(activity).toHaveBeenCalledTimes(1);
      expect(lines).not.toHaveBeenCalled();
      stderr("warning");
      expect(activity).toHaveBeenCalledTimes(2);
      stdout("\n");
    };
    sdk.logs.mockImplementation(async (_session, _command, stdout, stderr) =>
      emit(stdout, stderr),
    );
    sdk.runCommand.mockImplementation(
      async ({ stdout, stderr }: { stdout: Writable; stderr: Writable }) => {
        emit(
          (text) => stdout.write(text),
          (text) => stderr.write(text),
        );
        stdout.end();
        stderr.end();
        return { exitCode: 0 };
      },
    );
    const handle = await factory().create({ env: {} });
    try {
      const result = await handle.exec("fixture", {
        onActivity: activity,
        onLine: lines,
      });
      expect(result).toMatchObject({
        stdout: "partial",
        stderr: "warning",
        exitCode: 0,
      });
      expect(lines).toHaveBeenCalledWith("partial");
    } finally {
      await handle.close();
    }
  },
);
