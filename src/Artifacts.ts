import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Repository-relative evidence copied into a unique host directory per attempt. */
export interface ArtifactOptions {
  readonly root: string;
  readonly paths: readonly string[];
}

/** Failure requires retaining the worktree, including Git-clean evidence. */
export class ArtifactError extends Error {
  readonly preserveWorktree = true;
}

export interface ArtifactStore {
  readonly root: string;
  assertOutsideWorktree(worktree: string): Promise<void>;
  capture(worktree: string, iterationId?: string): Promise<string>;
}

export const createArtifactStore = async (
  options: ArtifactOptions,
  hostRepoDir: string,
): Promise<ArtifactStore> => {
  if (!options.root || options.paths.length === 0)
    throw new ArtifactError(
      "artifacts requires a root and at least one repository-relative path",
    );
  const paths = [...options.paths];
  for (const path of paths) {
    if (
      !path ||
      isAbsolute(path) ||
      path
        .split(/[\\/]/)
        .some(
          (part) => part === ".." || part === ".git" || part === ".sandcastle",
        ) ||
      path === "."
    )
      throw new ArtifactError(`Invalid artifact path: ${path}`);
  }
  const parent = resolve(hostRepoDir, options.root);
  if (paths.some((path) => contains(resolve(hostRepoDir, path), parent)))
    throw new ArtifactError(
      "Artifact root must be outside exported directories",
    );
  await mkdir(parent, { recursive: true });
  const root = join(parent, randomUUID());
  await mkdir(root);
  const canonicalRoot = await realpath(root);
  const canonicalHost = await realpath(hostRepoDir);
  const assertOutsideWorktree = async (worktree: string): Promise<void> => {
    const sourceRoot = await realpath(worktree);
    if (sourceRoot !== canonicalHost && contains(sourceRoot, canonicalRoot))
      throw new ArtifactError(
        "Artifact root must be outside removable worktrees",
      );
  };
  for (const path of paths) {
    const source = await realpath(resolve(hostRepoDir, path)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (source && contains(source, canonicalRoot))
      throw new ArtifactError(
        "Artifact root must be outside exported directories",
      );
  }
  return {
    root: canonicalRoot,
    assertOutsideWorktree,
    capture: async (worktree, iterationId = randomUUID()) => {
      const destination = join(canonicalRoot, iterationId);
      try {
        await assertOutsideWorktree(worktree);
        await mkdir(destination);
        const sourceRoot = await realpath(worktree);
        for (const path of paths) {
          const source = resolve(sourceRoot, path);
          if (contains(source, canonicalRoot))
            throw new ArtifactError(
              "Artifact root must be outside exported directories",
            );
          const target = join(destination, path);
          const sourceInfo = await lstat(source).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (!sourceInfo) continue;
          if (contains(await realpath(source), canonicalRoot))
            throw new ArtifactError(
              "Artifact root must be outside exported directories",
            );
          await cp(source, target, {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: async (entry) => {
              const info = await lstat(entry);
              const actual = await realpath(entry);
              const relativePath = relative(sourceRoot, actual);
              if (
                info.isSymbolicLink() ||
                !(info.isDirectory() || info.isFile()) ||
                relativePath === ".." ||
                relativePath.startsWith(`..${sep}`) ||
                isAbsolute(relativePath)
              )
                throw new Error(
                  `Artifact source must contain regular files/directories within the worktree: ${entry}`,
                );
              return true;
            },
          });
        }
        return destination;
      } catch (cause) {
        throw new ArtifactError(
          `Artifact export failed; preserve ${worktree}: ${String(cause)}`,
          { cause },
        );
      }
    },
  };
};
