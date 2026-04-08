import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

export class SafeFileError extends Error {
  code:
    | "invalid-path"
    | "not-found"
    | "outside-workspace"
    | "symlink"
    | "not-file"
    | "not-directory"
    | "path-mismatch"
    | "too-large";

  constructor(code: SafeFileError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafeFileError";
    this.code = code;
  }
}

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_EXISTING_FLAGS =
  fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

function ensureTrailingSep(value: string): string {
  return value.endsWith(path.sep) ? value : value + path.sep;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(value && typeof value === "object" && "code" in (value as Record<string, unknown>));
}

function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && (value.code === "ENOENT" || value.code === "ENOTDIR");
}

function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && (value.code === "ELOOP" || value.code === "EINVAL" || value.code === "ENOTSUP");
}

function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFileIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveOpenedFileRealPathForHandle(handle: FileHandle, ioPath: string): Promise<string> {
  try {
    return await fs.realpath(ioPath);
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
  }

  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];

  for (const fdPath of fdCandidates) {
    try {
      return await fs.realpath(fdPath);
    } catch {
      // Try the next fd path.
    }
  }

  throw new SafeFileError("path-mismatch", "unable to resolve opened file path");
}

async function resolvePathWithinRoot(rootDir: string, targetPath: string): Promise<{
  rootReal: string;
  rootWithSep: string;
  resolved: string;
}> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootDir);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new SafeFileError("not-found", "workspace root not found");
    }
    throw error;
  }

  const rootWithSep = ensureTrailingSep(rootReal);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(rootReal, targetPath);

  if (!isPathInside(rootWithSep, resolved)) {
    throw new SafeFileError("outside-workspace", `Path escapes workspace: ${targetPath}`);
  }

  return { rootReal, rootWithSep, resolved };
}

async function ensureDirectoryChainWithinRoot(rootReal: string, rootWithSep: string, dirPath: string): Promise<void> {
  const relativeDir = path.relative(rootReal, dirPath);
  if (!relativeDir || relativeDir === ".") {
    return;
  }

  let current = rootReal;
  for (const segment of relativeDir.split(path.sep)) {
    if (!segment || segment === ".") {
      continue;
    }

    const candidate = path.join(current, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new SafeFileError("symlink", `Path escapes workspace: ${dirPath}`);
      }
      if (!stat.isDirectory()) {
        throw new SafeFileError("invalid-path", `Not a directory: ${candidate}`);
      }
    } catch (error) {
      if (error instanceof SafeFileError) {
        throw error;
      }
      if (!isNotFoundPathError(error)) {
        throw error;
      }

      await fs.mkdir(candidate);
      const created = await fs.lstat(candidate);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new SafeFileError("symlink", `Path escapes workspace: ${dirPath}`);
      }
    }

    const realCandidate = await fs.realpath(candidate);
    if (!isPathInside(rootWithSep, realCandidate)) {
      throw new SafeFileError("outside-workspace", `Path escapes workspace: ${dirPath}`);
    }
    current = realCandidate;
  }
}

export async function readFileWithinRoot(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Promise<string> {
  const { rootWithSep, resolved } = await resolvePathWithinRoot(params.rootDir, params.filePath);

  let handle: FileHandle;
  try {
    handle = await fs.open(resolved, OPEN_READ_FLAGS);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new SafeFileError("not-found", `File not found: ${params.filePath}`);
    }
    if (isSymlinkOpenError(error)) {
      throw new SafeFileError("symlink", `Path escapes workspace: ${params.filePath}`, { cause: error });
    }
    throw error;
  }

  try {
    const [stat, lstat] = await Promise.all([handle.stat(), fs.lstat(resolved)]);
    if (lstat.isSymbolicLink()) {
      throw new SafeFileError("symlink", `Path escapes workspace: ${params.filePath}`);
    }
    if (!stat.isFile()) {
      throw new SafeFileError("not-file", `Not a file: ${params.filePath}`);
    }
    if (!sameFileIdentity(stat, lstat)) {
      throw new SafeFileError("path-mismatch", `Path changed during read: ${params.filePath}`);
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, resolved);
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new SafeFileError("path-mismatch", `Path changed during read: ${params.filePath}`);
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new SafeFileError("outside-workspace", `Path escapes workspace: ${params.filePath}`);
    }
    if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
      throw new SafeFileError("too-large", `File too large (${stat.size} bytes, max ${params.maxBytes})`);
    }

    return await handle.readFile({ encoding: "utf-8" });
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function writeFileWithinRoot(params: {
  rootDir: string;
  filePath: string;
  content: string;
}): Promise<void> {
  const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params.rootDir, params.filePath);
  await ensureDirectoryChainWithinRoot(rootReal, rootWithSep, path.dirname(resolved));

  let handle: FileHandle;
  let created = false;
  try {
    try {
      handle = await fs.open(resolved, OPEN_WRITE_EXISTING_FLAGS);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      handle = await fs.open(resolved, OPEN_WRITE_CREATE_FLAGS, 0o600);
      created = true;
    }
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new SafeFileError("symlink", `Path escapes workspace: ${params.filePath}`, { cause: error });
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SafeFileError("not-file", `Not a file: ${params.filePath}`);
    }
    if (stat.nlink > 1) {
      throw new SafeFileError("invalid-path", `Hardlinked path not allowed: ${params.filePath}`);
    }

    const lstat = await fs.lstat(resolved);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new SafeFileError("symlink", `Path escapes workspace: ${params.filePath}`);
    }
    if (!sameFileIdentity(stat, lstat)) {
      throw new SafeFileError("path-mismatch", `Path changed during write: ${params.filePath}`);
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, resolved);
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new SafeFileError("path-mismatch", `Path changed during write: ${params.filePath}`);
    }
    if (realStat.nlink > 1) {
      throw new SafeFileError("invalid-path", `Hardlinked path not allowed: ${params.filePath}`);
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new SafeFileError("outside-workspace", `Path escapes workspace: ${params.filePath}`);
    }

    if (!created) {
      await handle.truncate(0);
    }
    await handle.writeFile(params.content, "utf-8");
  } catch (error) {
    await handle.close().catch(() => {});
    if (created) {
      await fs.rm(resolved, { force: true }).catch(() => {});
    }
    throw error;
  }

  await handle.close().catch(() => {});
}

export async function listDirectoryWithinRoot(params: {
  rootDir: string;
  dirPath: string;
}): Promise<Awaited<ReturnType<typeof fs.readdir>>> {
  const { rootWithSep, resolved } = await resolvePathWithinRoot(params.rootDir, params.dirPath);
  const lstat = await fs.lstat(resolved).catch((error) => {
    if (isNotFoundPathError(error)) {
      throw new SafeFileError("not-found", `Directory not found: ${params.dirPath}`);
    }
    throw error;
  });

  if (lstat.isSymbolicLink()) {
    throw new SafeFileError("symlink", `Path escapes workspace: ${params.dirPath}`);
  }
  if (!lstat.isDirectory()) {
    throw new SafeFileError("not-directory", `Not a directory: ${params.dirPath}`);
  }

  const realPath = await fs.realpath(resolved);
  if (!isPathInside(rootWithSep, realPath)) {
    throw new SafeFileError("outside-workspace", `Path escapes workspace: ${params.dirPath}`);
  }

  return await fs.readdir(realPath, { withFileTypes: true });
}
