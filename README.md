# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/icandoitone/makefun-hidden-spec-cli-01-run-20261122-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/icandoitone/makefun-hidden-spec-cli-01-run-20261122-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one specification
(`SPEC.md` in the kit's starter):

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Each edit names the lines it replaces; `mend` finds them at the first of
three matching tiers — exact lines, then lines equal once trailing spaces and
tabs are removed, then lines equal once leading and trailing spaces and tabs
are removed — re-indenting new lines to the file's own indentation at the
third tier. Every file is changed or nothing is: a failed edit changes
nothing, the edits after it still run, and when any edit failed no file is
written at all.

## Running it

Node 22 or later, standard library only, no install step:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Output and exit codes

Standard output holds lines, each ended by a line feed, and nothing else.

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` for a patch that cannot be read in
  its format.
- Exit 1, nothing written: one line `error: <code> <path>` for each edit
  that failed (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), in
  the patch's order, then `failed: <k> of <n> edits`.
- Exit 0, the tree is written: one line for each path whose state changed,
  in byte order of the paths — `A <path>` for a file created, `D <path>` for
  a file deleted, `M <path>` for a file changed, `R <old> -> <new>` for a
  file moved — then `ok: <n> files` (or `ok: 1 file`).

## Practice score

Against the kit's 100 public practice checks
(`program/generator/practice.json`, run with the starter's `check.ts`):

**100 of 100 passed — practice score 1000.**

- unified: 30 of 30
- search_replace: 20 of 20
- v4a: 20 of 20
- json: 15 of 15
- cli: 15 of 15

The suite was run twice with identical results. A further 70 hand-built
probes covering corners the practice set never shows (no-newline-at-end-of-file
handling, empty-old-line hunks, move-only V4A sections, overlapping JSON
matches, unsafe paths, `--` handling, the trial handover against a local env)
also all pass.

## Files

- `main.ts` — the whole tool.
- `runner.ts` — the kit's trial runner, unchanged; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `README.md` — this file.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry's claim file.
