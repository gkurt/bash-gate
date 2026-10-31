---
name: changelog
description: Write a Tegami changelog entry (`.tegami/<slug>.md`). Use when finishing a change that ships in a published package — a feature, fix, or breaking refactor — or when asked for a changelog entry, changeset, or release note.
---

# Changelog entries

Releases are managed by [Tegami](https://tegami.fuma-nama.dev) (config in
`scripts/tegami.mts`). Every change that ships needs an entry — run
`bun run tegami`, or write `.tegami/<slug>.md` yourself:

```md
---
packages:
  "<pkg>": patch
---

### Menu rows light up under the pointer
```

- The body needs at least one heading. Tegami silently drops an entry without one.
- One sentence under the heading, often none — the heading is usually the whole entry.
- Write only what landed. A product change gets the user-facing effect; a refactor
  gets the new shape or the removed API. Nothing else.
