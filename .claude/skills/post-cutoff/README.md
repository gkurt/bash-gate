# post-cutoff

An agent skill that lists git, `gh` and GitHub features newer than a model's training
cutoff. Agents run [`scripts/post-cutoff.mts`](scripts/post-cutoff.mts); see
[`SKILL.md`](SKILL.md) for how they use it. This file is for maintaining it.

## Data

The script reads [`data/`](data/): one JSON file per tool, plus `models.json`. A new
tool is a new file with the same shape; the script picks it up.

A tool file has `tool` (the `--tool` key), `name`, `reviewed` (the date its changelog
was last checked), `changelogs`, an optional `version` (command and regex to read the
installed version), and `entries`. An entry has:

| Field | |
| --- | --- |
| `id` | `<tool>/<slug>`, unique and stable. Agents pass it to `--details`. |
| `date` | `YYYY-MM-DD`, or `YYYY-MM` when only the month is known. |
| `version` | Optional. The release that added it; compared with the installed version. |
| `feature` | The index line. Must say what the feature is without the summary. |
| `summary` | One clause, shown only with `--details`. |
| `check` | Optional. A local command (usually `--help`) that confirms it. |
| `docs` | The primary source. |
| `skill` | Optional. An official skill's install command. |

`models.json` maps model IDs (and short aliases) to training cutoffs. The index starts
3 months before a cutoff (`LOOKBACK_MONTHS`), because models know little about the
last months before it.

## Rules

- Add only features that change which command or workflow an agent would choose.
  Leave out performance work, internals and bug fixes.
- Sources are release notes, changelog posts and official docs. Model cutoffs come
  from the vendor's own model docs, never from third-party lists.
- Bump a tool's `reviewed` date whenever you check its changelog, even if nothing was
  added.
- Delete entries once every model in use was trained well after them.

## Checking changes

```bash
node scripts/post-cutoff.mts --tool gh,git,github --date 2026-01   # every entry; fails on malformed data or duplicate ids
node scripts/post-cutoff.mts --details gh/attach                   # one entry in full
```
