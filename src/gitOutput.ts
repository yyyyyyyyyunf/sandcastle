import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Bounded read-only Git queries through argv. */
export const gitOutput = async (
  cwd: string,
  ...args: string[]
): Promise<string> =>
  (await exec("git", args, { cwd, timeout: 10000 })).stdout.trim();
