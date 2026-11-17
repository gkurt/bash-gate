/** A Git index of `entries` (each a path and its mode), as git writes it in `version`, with `extensions` after them. */
export function gitIndex(
  entries: [path: string, mode: number][],
  {
    version = 2,
    hashSize = 20,
    extended = false,
    extensions = [],
  }: { version?: 2 | 3 | 4; hashSize?: 20 | 32; extended?: boolean; extensions?: [name: string, data: number[]][] } = {},
): Uint8Array {
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const u16 = (n: number) => bytes.push((n >>> 8) & 255, n & 255);
  const text = (s: string) => [...new TextEncoder().encode(s)];
  bytes.push(...text('DIRC'));
  u32(version);
  u32(entries.length);
  let previous: number[] = [];
  for (const [path, mode] of entries) {
    const start = bytes.length;
    // Times, device and inode, then the mode, ids and size.
    for (let i = 0; i < 6; i++) u32(0);
    u32(mode);
    for (let i = 0; i < 3; i++) u32(0);
    for (let i = 0; i < hashSize; i++) bytes.push(0xab);
    const name = text(path);
    u16((extended ? 0x40_00 : 0) | Math.min(name.length, 0xf_ff));
    if (extended) u16(0);
    if (version === 4) {
      let common = 0;
      while (common < previous.length && common < name.length && previous[common] === name[common]) common++;
      bytes.push(...varint(previous.length - common), ...name.slice(common), 0);
    } else {
      bytes.push(...name, 0);
      while ((bytes.length - start) % 8 !== 0) bytes.push(0);
    }
    previous = name;
  }
  for (const [name, data] of extensions) {
    bytes.push(...text(name));
    u32(data.length);
    bytes.push(...data);
  }
  for (let i = 0; i < hashSize; i++) bytes.push(0);
  return Uint8Array.from(bytes);
}

/** Git's offset varint: big-endian groups of seven bits, each but the last one less than it stands for. */
function varint(value: number): number[] {
  const out = [value & 127];
  for (value >>= 7; value !== 0; value >>= 7) out.unshift(128 | (--value & 127));
  return out;
}

export const gitlink = 0o160_000;
export const file = 0o100_644;
