import { readdir, realpath } from "fs/promises";
import path from "path";

export type PathApi = typeof path.posix;

const MEGABYTE = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 100;

export const MAX_UPLOAD_ENV_VAR = "PAPERLESS_MCP_MAX_UPLOAD_MB";

/** Upload size limit in bytes; `Infinity` when PAPERLESS_MCP_MAX_UPLOAD_MB is 0. */
export function getMaxUploadBytes(): number {
  const raw = process.env[MAX_UPLOAD_ENV_VAR]?.trim();
  const megabytes = raw ? Number(raw) : NaN;
  if (!Number.isFinite(megabytes) || megabytes < 0) {
    return DEFAULT_MAX_UPLOAD_MB * MEGABYTE;
  }
  return megabytes === 0 ? Infinity : megabytes * MEGABYTE;
}

export function assertWithinUploadLimit(sizeBytes: number): void {
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes > maxBytes) {
    throw new Error(
      `File size (${Math.round(sizeBytes / MEGABYTE)}MB) exceeds maximum allowed size (${maxBytes / MEGABYTE}MB). ` +
        `Set ${MAX_UPLOAD_ENV_VAR} to change the limit (0 = unlimited).`
    );
  }
}

export function assertAbsolutePath(
  filePath: string,
  pathApi: PathApi = path
): void {
  if (!pathApi.isAbsolute(filePath)) {
    throw new Error("file_path must be an absolute path");
  }
}

export function parseUploadPaths(
  value: string | undefined,
  pathApi: PathApi = path
): string[] {
  return value ? value.split(pathApi.delimiter).filter(Boolean) : [];
}

/**
 * Whether `realPath` is one of, or inside, `allowedDirs`. `path.win32.relative`
 * compares case-insensitively and returns an absolute path across drives or
 * UNC shares, which is rejected like a `..` escape.
 */
export function isPathAllowed(
  realPath: string,
  allowedDirs: string[],
  pathApi: PathApi = path
): boolean {
  return allowedDirs.some((dir) => {
    const relative = pathApi.relative(dir, realPath);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative)
    );
  });
}

async function tryRealpath(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

async function tryResolve(target: string): Promise<string | undefined> {
  for (const candidate of new Set([
    target,
    target.normalize("NFC"),
    target.normalize("NFD"),
  ])) {
    const resolved = await tryRealpath(candidate);
    if (resolved !== undefined) return resolved;
  }

  const parent = path.dirname(target);
  if (parent === target) return undefined;

  const realParent = await tryResolve(parent);
  if (realParent === undefined) return undefined;

  let entries: string[];
  try {
    entries = await readdir(realParent);
  } catch {
    return undefined;
  }
  const wanted = path.basename(target).normalize("NFC");
  const match = entries.find((name) => name.normalize("NFC") === wanted);
  return match === undefined
    ? undefined
    : tryRealpath(path.join(realParent, match));
}

/**
 * Resolves symlinks like `fs.realpath`, but also finds names whose Unicode
 * normalization (NFC/NFD) differs from the one on disk, in any path segment.
 */
export async function resolveExistingPath(target: string): Promise<string> {
  const resolved = await tryResolve(target);
  if (resolved === undefined) {
    throw new Error(
      `File not found: ${target} (tried the path as given, NFC and NFD forms, and a directory listing of the parent folder)`
    );
  }
  return resolved;
}

/** Resolves each allowed directory like the uploaded path; keeps it as given when it does not exist. */
export async function resolveAllowedDirs(allowed: string[]): Promise<string[]> {
  return Promise.all(
    allowed.map(async (dir) => (await tryResolve(dir)) ?? dir)
  );
}
