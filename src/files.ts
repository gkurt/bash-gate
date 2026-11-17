import type { Need } from './types.ts';

/** A value, or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The filesystem as it is before the command runs, in the shape of just-bash's `IFileSystem` and Node's `fs`: one of
 * them can be passed as it is. Every method is optional, and each may answer at once or with a promise (then only
 * `checkAsync` can use it). Paths use `/`, and are absolute when the analysis has an absolute `cwd`.
 *
 * Nothing there is an error whose `code` (Node) or message (just-bash) starts `ENOENT`, `ENOTDIR` or `EISDIR`, or
 * `null`. Not knowing is a missing method or `undefined`: the analysis then reports a `Need` and an `unknown-file`
 * finding, so the command isn't allowed. Other errors propagate to the caller.
 */
export interface FileSystem {
  /** A file's text, read as UTF-8. */
  readFile?(path: string, encoding: 'utf8'): MaybePromise<string | null | undefined>;
  /** A file's bytes: Git's index, for the repositories nested in a work tree that git looks into. */
  readFileBuffer?(path: string): MaybePromise<Uint8Array | null | undefined>;
  /** The names in a directory (not `.` or `..`). */
  readdir?(path: string): MaybePromise<string[] | null | undefined>;
  /** Where an absolute path really is, symlinks followed. */
  realpath?(path: string): MaybePromise<string | null | undefined>;
  /**
   * Whether anything is at a path, even a dangling symlink: where `realpath` finds nothing, this tells a dangling
   * symlink, where a write would go is unknown, from nothing, whose parent is tried instead.
   */
  lstat?(path: string): MaybePromise<{ isSymbolicLink: boolean | (() => boolean) } | null | undefined>;
}

/** What each kind of `Need` is answered with. */
interface Answers {
  file: string;
  bytes: Uint8Array;
  directory: string[];
  realpath: string;
}

/** Nothing is there: what Node's `code` and just-bash's message say. */
function absent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const named = typeof code === 'string' ? code : typeof message === 'string' ? /^E[A-Z]+/.exec(message)?.[0] : undefined;
  return named === 'ENOENT' || named === 'ENOTDIR' || named === 'EISDIR';
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/** `done` with what `run` gives, or `failed` with what it throws, at once or later, as `run` answers. */
function settle<T, R>(
  run: () => MaybePromise<T>,
  done: (value: T) => MaybePromise<R>,
  failed: (error: unknown) => MaybePromise<R>,
): MaybePromise<R> {
  let value: MaybePromise<T>;
  try {
    value = run();
  } catch (error) {
    return failed(error);
  }
  return isPromise(value) ? value.then(done, failed) : done(value);
}

const same = <T>(value: T): T => value;
const nothing = (error: unknown): null => {
  if (absent(error)) return null;
  throw error;
};

/** Asks `fs` what `kind` asks of `path`: `undefined` when it has no method for that. */
export function answer<K extends Need['kind']>(fs: FileSystem, kind: K, path: string): MaybePromise<Answers[K] | null | undefined> {
  type Answer = MaybePromise<Answers[K] | null | undefined>;
  switch (kind) {
    case 'file':
      return (fs.readFile ? settle(() => fs.readFile!(path, 'utf8'), same, nothing) : undefined) as Answer;
    case 'bytes':
      return (fs.readFileBuffer ? settle(() => fs.readFileBuffer!(path), same, nothing) : undefined) as Answer;
    case 'directory':
      return (fs.readdir ? settle(() => fs.readdir!(path), same, nothing) : undefined) as Answer;
    case 'realpath':
      if (!fs.realpath) return undefined;
      return settle(
        () => fs.realpath!(path),
        same,
        (error) => {
          if (!absent(error)) throw error;
          // Something there that has no real path is a dangling symlink: where it leads isn't known.
          if (!fs.lstat) return undefined;
          return settle(
            () => fs.lstat!(path),
            (stat) => (stat === null ? null : undefined),
            nothing,
          );
        },
      ) as Answer;
  }
}

/** Whether `fs` has a method for `kind`. */
export function answers(fs: FileSystem, kind: Need['kind']): boolean {
  const has = { file: 'readFile', bytes: 'readFileBuffer', directory: 'readdir', realpath: 'realpath' } as const;
  return fs[has[kind]] !== undefined;
}

/** What's known of a filesystem: a path in none of the records isn't known, and a record not given isn't asked. */
export interface Snapshot {
  files?: Record<string, string | null>;
  realpaths?: Record<string, string | null>;
  /** Directories' names, as `readdir` gives them. */
  directories?: Record<string, string[] | null>;
  /** Files' bytes, as `readFileBuffer` gives them. */
  buffers?: Record<string, Uint8Array | null>;
}

export function snapshot({ files, realpaths, directories, buffers }: Snapshot): FileSystem {
  const from =
    <T>(record: Record<string, T>) =>
    (path: string): T | undefined =>
      Object.hasOwn(record, path) ? record[path] : undefined;
  return {
    ...(files ? { readFile: from(files) } : {}),
    ...(realpaths ? { realpath: from(realpaths) } : {}),
    ...(directories ? { readdir: from(directories) } : {}),
    ...(buffers ? { readFileBuffer: from(buffers) } : {}),
  };
}

/** Asks a `FileSystem` each question once, and keeps what it didn't know. It must answer at once. */
export class Probe {
  fs: FileSystem;
  needs = new Map<string, Need>();
  known = new Map<string, unknown>();

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  ask<K extends Need['kind']>(kind: K, path: string): Answers[K] | null | undefined {
    const key = `${kind}\0${path}`;
    if (!this.known.has(key)) {
      const value = answer(this.fs, kind, path);
      if (isPromise(value)) {
        value.catch(() => undefined);
        throw new TypeError('The filesystem answers with promises: use checkAsync');
      }
      this.known.set(key, value);
    }
    const value = this.known.get(key) as Answers[K] | null | undefined;
    if (value === undefined && answers(this.fs, kind)) this.needs.set(key, { kind, path });
    return value;
  }

  readFile(path: string): string | null | undefined {
    return this.ask('file', path);
  }

  /** Whether the filesystem can list directories at all. */
  get lists(): boolean {
    return answers(this.fs, 'directory');
  }

  readDirectory(path: string): string[] | null | undefined {
    return this.ask('directory', path);
  }

  /** Whether the filesystem can read a file's bytes at all. */
  get readsBytes(): boolean {
    return answers(this.fs, 'bytes');
  }

  readBytes(path: string): Uint8Array | null | undefined {
    return this.ask('bytes', path);
  }

  realpath(path: string): string | null | undefined {
    return this.ask('realpath', path);
  }

  /**
   * Where the absolute `path` really is: the real path of its deepest ancestor that exists, then the rest, which doesn't
   * exist yet and so holds no symlinks. `undefined` when that isn't known. Past a level it doesn't know, it still asks
   * about the ones above, so that one round of fetching answers them all.
   */
  physical(path: string): string | undefined {
    let base = path;
    let rest = '';
    let known = true;
    for (;;) {
      const real = this.realpath(base);
      if (real === undefined) known = false;
      else if (real !== null) return known ? (rest === '' ? real : `${real.replace(/\/+$/, '')}/${rest}`) : undefined;
      if (base === '/') return undefined;
      const slash = base.lastIndexOf('/');
      rest = rest === '' ? base.slice(slash + 1) : `${base.slice(slash + 1)}/${rest}`;
      base = base.slice(0, slash) || '/';
    }
  }
}

/** Paths the script may have changed by some point, resolved; `any` when one of them can't be known. */
export class Changes {
  paths = new Set<string>();
  /** Those of `paths` written by what may make a repository there: not git checking out a file, which makes no `.git`. */
  repositories = new Set<string>();
  /** Work trees git may have rewritten: everything under each but its `.git`, which git never writes there. */
  trees: { root: string; git: string }[] = [];
  /** Files by name, wherever they are: what a compiler emits (`.js`, `.d.ts`). */
  patterns: RegExp[] = [];
  any = false;
  /** Project code the analysis trusts but doesn't follow (a test run, a build) may have changed any path. */
  project = false;

  add(path: string | undefined, repository = true): void {
    if (path === undefined) return void (this.any = true);
    this.paths.add(path);
    if (repository) this.repositories.add(path);
  }

  addTree(root: string, git: string): void {
    this.trees.push({ root, git });
  }

  addPattern(pattern: RegExp): void {
    if (!this.patterns.includes(pattern)) this.patterns.push(pattern);
  }

  /** Adds what `other` may have changed. */
  merge(other: Changes): void {
    for (const path of other.paths) this.paths.add(path);
    for (const path of other.repositories) this.repositories.add(path);
    this.trees.push(...other.trees);
    for (const pattern of other.patterns) this.addPattern(pattern);
    this.any ||= other.any;
    this.project ||= other.project;
  }

  get empty(): boolean {
    return !this.named && !this.project;
  }

  /** Whether anything but project code may have changed something. */
  get named(): boolean {
    return this.any || this.paths.size > 0 || this.trees.length > 0 || this.patterns.length > 0;
  }

  /** Whether `path` is, or may be, a changed path or under one. */
  covers(path: string): boolean {
    if (this.any) return true;
    for (const changed of this.paths) if (within(path, changed)) return true;
    if (this.patterns.some((pattern) => pattern.test(path))) return true;
    return under(this.trees, path);
  }

  /**
   * Whether something under the directory `dir`, but certainly not in `except`, may be a changed path, and (`dotGit`)
   * one with a `.git` on its way under `dir`: a file's contents only make a repository there in a `.git`. Git's
   * rewrites of a work tree make no `.git`, and patterns name files.
   */
  reaches(dir: string, except: string, dotGit: boolean): boolean {
    if (this.any) return true;
    for (const changed of this.repositories) {
      if (within(dir, changed) && !dotGit) return true;
      if (!within(changed, dir) || compare(changed, except) === true) continue;
      const below = compare(changed, dir) === true ? changed.slice(dir.length) : changed;
      if (!dotGit || below.split('/').some((name) => name.toLowerCase() === '.git')) return true;
    }
    return false;
  }
}

/** Whether `path` is in one of `trees`, but not its `.git`. */
function under(trees: { root: string; git: string }[], path: string): boolean {
  return trees.some(({ root, git }) => within(path, root) && !compare(path, git));
}

/** Whether `path` is `dir` or under it. Paths that can't be compared (`~`, relative to another place) may be. */
function within(path: string, dir: string): boolean {
  // On a filesystem that ignores case, `.HUSKY/x` is `.husky/x`: a write in either spelling may be the file.
  return compare(path.toLowerCase(), dir.toLowerCase()) ?? true;
}

/** Whether `path` is `dir` or under it; `undefined` when they can't be compared. */
export function compare(path: string, dir: string): boolean | undefined {
  if (dir.startsWith('~') || path.startsWith('~') || path.startsWith('/') !== dir.startsWith('/')) return undefined;
  const [dirUp, dirRest] = steps(dir);
  const [pathUp, pathRest] = steps(path);
  if (dirUp !== pathUp) return undefined;
  return dirRest === '' || pathRest === dirRest || pathRest.startsWith(`${dirRest}/`);
}

/** A normalised path as the `..` it starts with and the names after them: `../../a/b` is `[2, 'a/b']`. */
function steps(path: string): [number, string] {
  const body = path === '.' || path === '/' ? '' : path.replace(/^\//, '');
  const up = /^(?:\.\.(?:\/|$))*/.exec(body)![0];
  return [up.split('..').length - 1, body.slice(up.length)];
}
