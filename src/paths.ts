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
 * where the script started), and `~` paths stay under `~`. `undefined` when it can't be known: `cwd` is unknown, or
 * `..` leaves `~`.
 */
export function resolvePath(cwd: string | undefined, path: string): string | undefined {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return normalize(path);
  if (cwd === undefined) return undefined;
  return normalize(`${cwd}/${path}`);
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
