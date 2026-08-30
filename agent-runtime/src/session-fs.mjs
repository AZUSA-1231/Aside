import { constants } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { err, FileError, ok } from "@earendil-works/pi-agent-core/aside";

function toFileError(error, path) {
  if (error instanceof FileError) return error;
  const code = error?.code;
  const mapped =
    code === "ENOENT"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? "permission_denied"
        : code === "ENOTDIR"
          ? "not_directory"
          : code === "EISDIR"
            ? "is_directory"
            : code === "EINVAL"
              ? "invalid"
              : "unknown";
  return new FileError(mapped, error instanceof Error ? error.message : String(error), path);
}

function fileKind(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return undefined;
}

function fileInfo(path, stats) {
  const kind = fileKind(stats);
  if (!kind) throw new FileError("invalid", "Unsupported filesystem object.", path);
  return {
    name: basename(path),
    path,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function aborted(signal, path) {
  return signal?.aborted
    ? err(new FileError("aborted", "The filesystem operation was cancelled.", path))
    : undefined;
}

async function fallible(path, operation, signal) {
  const abortResult = aborted(signal, path);
  if (abortResult) return abortResult;
  try {
    return ok(await operation());
  } catch (error) {
    return err(toFileError(error, path));
  }
}

export function createNodeSessionFileSystem({ cwd = process.cwd() } = {}) {
  return {
    cwd: resolve(cwd),

    absolutePath(path, signal) {
      return fallible(path, () => resolve(isAbsolute(path) ? path : join(this.cwd, path)), signal);
    },

    joinPath(parts, signal) {
      return fallible(parts.join("\\"), () => join(...parts), signal);
    },

    readTextFile(path, signal) {
      return fallible(path, () => readFile(path, "utf8"), signal);
    },

    async readTextLines(path, options = {}) {
      const result = await fallible(path, () => readFile(path, "utf8"), options.abortSignal);
      if (!result.ok) return result;
      const lines = result.value.split(/\r?\n/);
      return ok(
        options.maxLines === undefined ? lines : lines.slice(0, options.maxLines),
      );
    },

    writeFile(path, content, signal) {
      return fallible(path, () => writeFile(path, content), signal);
    },

    appendFile(path, content, signal) {
      return fallible(path, () => appendFile(path, content), signal);
    },

    renameFile(sourcePath, destinationPath, signal) {
      return fallible(sourcePath, () => rename(sourcePath, destinationPath), signal);
    },

    async fileInfo(path, signal) {
      return fallible(path, async () => fileInfo(path, await lstat(path)), signal);
    },

    async listDir(path, signal) {
      return fallible(
        path,
        async () => {
          const entries = await readdir(path);
          const infos = [];
          for (const name of entries) {
            const entryPath = join(path, name);
            infos.push(fileInfo(entryPath, await lstat(entryPath)));
          }
          return infos;
        },
        signal,
      );
    },

    exists(path, signal) {
      const abortResult = aborted(signal, path);
      if (abortResult) return Promise.resolve(abortResult);
      return access(path, constants.F_OK)
        .then(() => ok(true))
        .catch((error) => {
          if (error?.code === "ENOENT") return ok(false);
          return err(toFileError(error, path));
        });
    },

    createDir(path, options = {}) {
      return fallible(
        path,
        () => mkdir(path, { recursive: options.recursive ?? true }),
        options.abortSignal,
      );
    },

    remove(path, options = {}) {
      return fallible(
        path,
        () =>
          rm(path, {
            force: options.force ?? false,
            recursive: options.recursive ?? false,
          }),
        options.abortSignal,
      );
    },

    async cleanup() {},
  };
}
