/** Directories a clean shell's `PATH` holds: a program given by a path in one of them is the system program. */
const systemDirs = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/sbin', '/usr/sbin', '/usr/local/sbin']);

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}

export function isSystemPath(path: string): boolean {
  const slash = path.lastIndexOf('/');
  return systemDirs.has(normalize(path.slice(0, slash) || '/') ?? '');
}

/**
 * `path` resolved against `cwd`, normalised: `//`, `.` and `..` folded. Paths stay relative when `cwd` is (`.` is
 * where the script started). `~` is `home` when that's known, and stays `~` otherwise; `~+` is `cwd`. `undefined`
 * when it can't be known: `cwd` is unknown, `..` leaves an unknown `~`, or another user's home (`~root`) or `~-`.
 */
export function resolvePath(cwd: string | undefined, path: string, home?: string): string | undefined {
  const tilde = /^~([^/]*)(.*)$/.exec(path);
  if (tilde) {
    const [, user, rest] = tilde;
    if (user === '+') return cwd === undefined ? undefined : resolvePath(cwd, `.${rest}`, home);
    if (user !== '') return undefined;
    return normalize(home === undefined ? path : `${home}/${rest}`);
  }
  if (path.startsWith('/')) return normalize(path);
  if (cwd === undefined) return undefined;
  return cwd.startsWith('~') ? resolvePath(undefined, `${cwd}/${path}`, home) : normalize(`${cwd}/${path}`);
}

/** `path` with `home` written as `~`, for matching `~` globs, or `undefined` when it isn't under `home`. */
export function tildePath(path: string, home: string | undefined): string | undefined {
  if (home === undefined) return undefined;
  const root = normalize(home);
  if (root === undefined || !root.startsWith('/')) return undefined;
  if (path === root) return '~';
  return path.startsWith(`${root === '/' ? '' : root}/`) ? `~${path.slice(root === '/' ? 0 : root.length)}` : undefined;
}

/** The normalised absolute `path` from the normalised absolute directory `base`: `x`, `../y`, or `.` for `base` itself. */
export function relativePath(path: string, base: string): string {
  const from = base.split('/').filter(Boolean);
  const to = path.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join('/') || '.';
}

function normalize(path: string): string | undefined {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      const last = parts[parts.length - 1];
      if (last === '~') return undefined;
      if (last !== undefined && last !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  if (absolute) return `/${parts.join('/')}`;
  return parts.join('/') || '.';
}
