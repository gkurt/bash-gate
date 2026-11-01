import type { Need } from './types.ts';

/**
 * The filesystem as it is before the command runs. Paths use `/`, and are absolute when the analysis has an absolute
 * `cwd`. Each answer is `null` when nothing is there, and `undefined` when it isn't known: the analysis then reports a
 * `Need` and an `unknown-file` finding, so the command isn't allowed. Errors thrown propagate to the caller.
 */
export interface FileSystem {
  /** A file's text; `null` when nothing is there or it isn't a file. */
  readFile(path: string): string | null | undefined;
  /**
   * Where an absolute path really is, symlinks followed; `null` only when nothing at all is there, not even a dangling
   * symlink (its parent is tried instead).
   */
  realpath(path: string): string | null | undefined;
}

/** A `FileSystem` only reachable asynchronously (a browser, a remote sandbox), for `checkAsync`. */
export interface AsyncFileSystem {
  readFile(path: string): Promise<string | null>;
  realpath(path: string): Promise<string | null>;
}

/** What's known of a filesystem: a path in neither record isn't known. */
export interface Snapshot {
  files?: Record<string, string | null>;
  realpaths?: Record<string, string | null>;
}

export function snapshot({ files = {}, realpaths = {} }: Snapshot): FileSystem {
  return {
    readFile: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    realpath: (path) => (Object.hasOwn(realpaths, path) ? realpaths[path] : undefined),
  };
}

/** Asks a `FileSystem` each question once, and keeps what it didn't know. */
export class Probe {
  fs: FileSystem;
  needs = new Map<string, Need>();
  texts = new Map<string, string | null | undefined>();
  reals = new Map<string, string | null | undefined>();

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  readFile(path: string): string | null | undefined {
    if (!this.texts.has(path)) this.texts.set(path, this.fs.readFile(path));
    const text = this.texts.get(path);
    if (text === undefined) this.needs.set(`file\0${path}`, { kind: 'file', path });
    return text;
  }

  realpath(path: string): string | null | undefined {
    if (!this.reals.has(path)) this.reals.set(path, this.fs.realpath(path));
    const real = this.reals.get(path);
    if (real === undefined) this.needs.set(`realpath\0${path}`, { kind: 'realpath', path });
    return real;
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
  /** Work trees git may have rewritten: everything under each but its `.git`, which git never writes there. */
  trees: { root: string; git: string }[] = [];
  any = false;

  add(path: string | undefined): void {
    if (path === undefined) this.any = true;
    else this.paths.add(path);
  }

  addTree(root: string, git: string): void {
    this.trees.push({ root, git });
  }

  get empty(): boolean {
    return !this.any && this.paths.size === 0 && this.trees.length === 0;
  }

  /** Whether `path` is, or may be, a changed path or under one. */
  covers(path: string): boolean {
    if (this.any) return true;
    for (const changed of this.paths) if (within(path, changed)) return true;
    return this.trees.some(({ root, git }) => within(path, root) && !compare(path, git));
  }
}

/** Whether `path` is `dir` or under it. Paths that can't be compared (`~`, relative to another place) may be. */
function within(path: string, dir: string): boolean {
  return compare(path, dir) ?? true;
}

/** Whether `path` is `dir` or under it; `undefined` when they can't be compared. */
function compare(path: string, dir: string): boolean | undefined {
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
