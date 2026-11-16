---
packages:
  'bash-gate': patch
---

### git checkout of a file, rebase --onto, reads through a descriptor, and system writes from /

- **`git checkout WORD`:** with a filesystem, this restores a file or directory of that name over uncommitted changes when no branch, tag, remote branch or ref has the name. It now counts as `--force`, which `recommended` asks about.
- **`git rebase --onto`:** asks, since it drops the commits it leaves out.
- **Descriptor reads:** a file `exec` opened on a descriptor is read by a later `<&N` (`exec 3< .env; cat <&3`), and by every command that inherits standard input opened that way (`exec < .env; cat`). The shell state follows copies (`4<&3`), closes and reopens.
- **System writes:** `recommended` asks before writes to `/usr`, `/bin`, `/sbin`, `/lib`, `/etc` and `/boot`, even from a script started at `/`. A program written to `/usr/local/bin` would otherwise be trusted as the system's.
