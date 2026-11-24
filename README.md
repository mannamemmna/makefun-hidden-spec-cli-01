# mend

mend applies an edit an AI model wrote to a tree of text files. Models describe edits in incompatible formats,
often with damaged details such as wrong hunk line numbers or drifted indentation; mend reads all of them and
rewrites the tree in one all-or-nothing pass, in Node with only the standard library. SPEC.md is the contract.

## The four patch formats

- `unified` — a `diff --git` patch with `@@` hunks. Hunk headers are hints, not truth, so wrong counts do not
  break the match.
- `search-replace` — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks; each block must match exactly once.
- `v4a` — `*** Begin Patch` with `*** Add File:`, `*** Delete File:`, `*** Update File:`, `*** Move to:` and
  anchored `@@` chunks.
- `json` — a JSON array or JSON Lines of edit objects using the `create`, `str_replace` and `insert` commands.

The format is detected from the patch text, or forced with `--format`.

## The three matching tiers

Old lines are located at the first of three tiers where they occur: tier 0 matches every line exactly, tier 1
matches after trailing whitespace is dropped from both sides, tier 2 after leading and trailing whitespace are
dropped, with replacement lines re-indented to the file's own indentation. `--strict` allows tier 0 only.

## Usage

    node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]

PATCH is a patch path relative to the working directory, which is the tree's root; without it, or as `-`, the
patch comes from stdin. `--check` does everything except the writes. Changed paths print as `A`/`D`/`M`/`R` lines
in byte order then `ok: <n> files` (exit 0); failed edits print `error: <code> <path>` lines and
`failed: <k> of <n> edits` (exit 1); bad invocations print one `error: usage|no-patch|format|parse <N>` line
(exit 2). Nothing is written unless every edit succeeds.

## Practice checker

The kit carries the public practice set at `program/generator/practice.json`:

    node check.ts ../program/generator/practice.json

It runs main.ts on every check, prints each failure with the difference, then the score. This implementation
passes the whole practice set: 100 of 100 checks, practice score 1000.

## Licence

MIT (see LICENSE).
