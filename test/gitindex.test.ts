import { describe, expect, test } from 'bun:test';
import { gitlinks } from '#src/gitindex.ts';
import { file, gitIndex, gitlink } from './git-index.ts';

const entries: [string, number][] = [
  ['a', file],
  ['src/deep/a.ts', file],
  ['src/deep/sub', gitlink],
  ['src/é', gitlink],
  ['vendor/nested', gitlink],
];

describe('gitlinks', () => {
  test('reads the gitlinks of every version git writes', () => {
    for (const version of [2, 3, 4] as const)
      expect(gitlinks(gitIndex(entries, { version }), 20)).toEqual(['src/deep/sub', 'src/é', 'vendor/nested']);

    expect(gitlinks(gitIndex(entries, { version: 3, extended: true }), 20)).toEqual(['src/deep/sub', 'src/é', 'vendor/nested']);
    expect(gitlinks(gitIndex(entries, { hashSize: 32 }), 32)).toEqual(['src/deep/sub', 'src/é', 'vendor/nested']);
    expect(gitlinks(gitIndex([]), 20)).toEqual([]);
  });

  test('skips an extension git may ignore, but not one it must understand', () => {
    expect(gitlinks(gitIndex(entries, { extensions: [['TREE', [1, 2, 3]]] }), 20)).toHaveLength(3);
    // A split index keeps entries in another file; a sparse one folds directories.
    expect(gitlinks(gitIndex(entries, { extensions: [['link', [1, 2, 3]]] }), 20)).toBeUndefined();
    expect(gitlinks(gitIndex(entries, { extensions: [['sdir', []]] }), 20)).toBeUndefined();
  });

  test('what it does not read as git does is undefined', () => {
    const index = gitIndex(entries);
    expect(gitlinks(index, 32)).toBeUndefined();
    expect(gitlinks(index.subarray(0, index.length - 30), 20)).toBeUndefined();
    expect(gitlinks(Uint8Array.from([...index.subarray(0, 4), 0, 0, 0, 5, ...index.subarray(8)]), 20)).toBeUndefined();
    expect(gitlinks(gitIndex(entries, { version: 2, extended: true }), 20)).toBeUndefined();
    for (const path of ['../out', '/etc', 'a//b', 'a/./b'])
      expect([path, gitlinks(gitIndex([[path, gitlink]]), 20)]).toEqual([path, undefined]);
    expect(gitlinks(new Uint8Array(), 20)).toBeUndefined();
  });
});
