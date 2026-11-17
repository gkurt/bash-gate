/**
 * The paths of the gitlinks (mode 160000: a commit of a repository nested in the work tree) a Git index records, in
 * versions 2 to 4, for a repository whose object names are `hashSize` bytes. `undefined` when it isn't read here as
 * git reads it: a malformed index, an extension git must understand (a split or sparse index), or a path that isn't
 * UTF-8 or leaves the work tree.
 */
export function gitlinks(index: Uint8Array, hashSize: 20 | 32): string[] | undefined {
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  // The checksum of what's before it ends the file.
  const end = index.length - hashSize;
  if (end < 12 || view.getUint32(0) !== 0x44_49_52_43) return undefined;
  const version = view.getUint32(4);
  if (version < 2 || version > 4) return undefined;
  const count = view.getUint32(8);
  const links: string[] = [];
  let offset = 12;
  let previous: number[] = [];
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    // Times, device, inode, mode, ids and size, then the object name and the flags.
    const fixed = 40 + hashSize + 2;
    if (offset + fixed > end) return undefined;
    const mode = view.getUint32(offset + 24);
    const flags = view.getUint16(offset + 40 + hashSize);
    const extended = (flags & 0x40_00) !== 0;
    // Git takes the name's length from the flags, and looks for its end only when it's too long for them.
    const length = flags & 0xf_ff;
    offset += fixed;
    if (extended) {
      if (version < 3) return undefined;
      offset += 2;
    }
    let path: number[];
    if (version === 4) {
      // How many bytes of the previous path to drop, as git's varint, then the rest of this one.
      let byte = offset < end ? index[offset++]! : 0x80;
      let drop = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= end || drop > previous.length) return undefined;
        byte = index[offset++]!;
        drop = ((drop + 1) << 7) | (byte & 0x7f);
      }
      if (drop > previous.length) return undefined;
      const kept = previous.length - drop;
      const nul = nameEnd(index, offset, length === 0xf_ff ? undefined : length - kept, end);
      if (nul === undefined) return undefined;
      path = [...previous.slice(0, kept), ...index.subarray(offset, nul)];
      offset = nul + 1;
    } else {
      const nul = nameEnd(index, offset, length === 0xf_ff ? undefined : length, end);
      if (nul === undefined) return undefined;
      path = [...index.subarray(offset, nul)];
      // Padded to a multiple of eight bytes, at least one, which git skips without reading.
      offset = start + ((nul - start + 8) & ~7);
      if (offset > end) return undefined;
    }
    previous = path;
    if ((mode & 0o170_000) !== 0o160_000) continue;
    const text = utf8(path);
    if (
      text === undefined ||
      text === '' ||
      text.startsWith('/') ||
      text.split('/').some((name) => name === '' || name === '.' || name === '..')
    )
      return undefined;
    links.push(text);
  }
  // Extensions: one whose name starts with a capital letter git may ignore, and so may this.
  while (offset < end) {
    if (offset + 8 > end) return undefined;
    const first = index[offset]!;
    if (first < 0x41 || first > 0x5a) return undefined;
    offset += 8 + view.getUint32(offset + 4);
  }
  return offset === end ? links : undefined;
}

/**
 * Where the name at `offset` ends: `length` bytes on, or at the first NUL when the flags don't hold its length. A NUL
 * inside it, or none after it, is `undefined`, as git's string functions would read another name than its length.
 */
function nameEnd(index: Uint8Array, offset: number, length: number | undefined, end: number): number | undefined {
  const nul = index.indexOf(0, offset);
  if (nul < 0 || nul >= end) return undefined;
  if (length === undefined) return nul;
  return length >= 0 && nul === offset + length ? nul : undefined;
}

function utf8(bytes: number[]): string | undefined {
  try {
    return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return undefined;
  }
}
