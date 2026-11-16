/**
 * A `readDirectory` for a fixture filesystem given by its paths: a directory holds the names one level below it, and a
 * path with nothing below it isn't one. Relative paths (a fixture with no absolute `cwd`) are listed from `.`.
 */
export function listing(paths: Iterable<string>): (dir: string) => string[] | null {
  const strip = (path: string) => path.replace(/^\.(\/|$)/, '');
  const all = [...paths].map(strip);
  return (dir) => {
    const key = strip(dir);
    const prefix = key === '' ? '' : `${key.replace(/\/+$/, '')}/`;
    const names = new Set<string>();
    for (const path of all) if (path.startsWith(prefix) && path.length > prefix.length) names.add(path.slice(prefix.length).split('/')[0]!);
    return names.size > 0 ? [...names] : null;
  };
}
