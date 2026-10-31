---
name: post-cutoff
description: Lists git, GitHub CLI (gh) and GitHub platform features released after your training cutoff — commands, flags and workflows you will not know exist. Run its script with your model ID before running git or gh commands, opening or editing pull requests and issues, rewriting history, or choosing a branching, review or merge workflow; and whenever the user names a git, gh or GitHub feature you do not recognize. It only says what exists and where it is documented; it defers to official docs and official skills for how to use it.
---

# Post-cutoff

A script that lists the features newer than your training cutoff, one line each, and
gives the details of a feature only when you ask for it. Run it from this skill's
directory with Node 22.18+ or Bun.

## 1. List what is new for the tools you are about to use

```bash
node scripts/post-cutoff.mts --tool <tools> --model <your model ID>
```

- `--tool` is required. Pass only the tools the task involves: `gh`, `git`, `github`
  (the github.com platform), comma-separated.
- `--model` takes your own model ID (e.g. `claude-opus-5-5`). If it is unknown, the
  error lists the known ones; pass `--date <your training cutoff, YYYY-MM>` instead.
- The list starts 3 months before your cutoff, since you know little about those months.

Each line is an id, release date and version, and the feature's name. Lines marked
`[needs <tool> >= <version>]` are newer than the installed tool: tell the user an
upgrade is needed instead of improvising a workaround.

## 2. Read the details only of features you are going to use

```bash
node scripts/post-cutoff.mts --details <id>[,<id>]
```

This prints the summary, a `check` command, the `docs` link and any official skill.
Skip it for features that do not bear on the task. Before using a feature:

1. **Use the official skill if the entry lists one.** If it is installed, load it and
   follow it; it supersedes this skill. If not, give the user its install command; do
   not install it unasked.
2. **Run the `check` command.** Local `--help` output is authoritative for the installed
   version and wins over this skill when they disagree.
3. **Read the `docs` link before relying on details** such as flag semantics, limits
   and edge cases. Do not fill gaps from memory.
4. **Preview and experimental features change without notice.** Re-check `--help`
   rather than trusting an earlier session.

Anything after a tool's `reviewed` date is not listed; the index links that tool's
changelogs for it. Add `--json` to either command for machine-readable output.
