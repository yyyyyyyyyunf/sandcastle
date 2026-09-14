/**
 * Release helper: consume pending changesets, commit the version bump, and
 * create the `v*` tag that triggers .github/workflows/release.yml (npm publish).
 *
 *   npm run release [-- --push]
 *
 * Requires a clean worktree on `main`. With no pending changesets it tags the
 * current package.json version as-is (e.g. to tag an already-versioned
 * release). Without `--push` the commit and tag stay local and the push
 * commands are printed at the end.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const run = (cmd: string, args: string[]): void => {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0) fail(`command failed: ${cmd} ${args.join(" ")}`);
};

const out = (cmd: string, args: string[]): string => {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) fail(`command failed: ${cmd} ${args.join(" ")}`);
  return result.stdout.trim();
};

const packageVersion = (): string =>
  (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
    .version;

const push = process.argv.includes("--push");

if (out("git", ["status", "--porcelain"])) {
  fail("worktree is not clean — commit or stash first");
}
const branch = out("git", ["branch", "--show-current"]);
if (branch !== "main") {
  fail(`not on main (on "${branch}")`);
}

const pendingChangesets = readdirSync(".changeset").filter(
  (f) => f.endsWith(".md") && f !== "README.md",
);

console.log("running preflight: typecheck + build + test");
run("npm", ["run", "typecheck"]);
// build before test: cli tests exec the compiled dist/main.js
run("npm", ["run", "build"]);
// git-heavy tests are slow under parallel load; give them room
run("npm", ["test", "--", "--testTimeout=20000"]);

let version = packageVersion();

if (pendingChangesets.length > 0) {
  console.log(`consuming ${pendingChangesets.length} changeset(s)`);
  run("npx", ["changeset", "version"]);
  // changesets does not sync the lockfile's version fields
  run("npm", ["install", "--package-lock-only"]);
  version = packageVersion();
  // worktree was clean before versioning, so everything dirty is the release
  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-m",
    `chore: version fly4ai sandcastle ${version}`,
  ]);
}

const tag = `v${version}`;
const tagExists =
  spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])
    .status === 0;
if (tagExists) {
  fail(`tag ${tag} already exists`);
}

run("git", ["tag", tag]);
console.log(`created tag ${tag}`);

if (push) {
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", tag]);
  console.log("pushed main and tag — release workflow is running");
} else {
  console.log(
    `\nto publish, run:\n  git push origin main && git push origin ${tag}\n(or re-run with --push)`,
  );
}
