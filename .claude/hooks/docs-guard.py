#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DropScribe documentation guard — a Claude Code hook, standard library only.

WHAT IT DOES
------------
It runs twice per turn, wired in `.claude/settings.json`:

  * `UserPromptSubmit` with `--snapshot` — records mtime + size + sha1 of every
    file under `src/`, `electron/`, `scripts/`, `test/` and `docs/` into
    `.claude/.docs-guard-snapshot.json`, then exits 0 in complete silence.
  * `Stop` with no arguments — diffs the tree against that snapshot. If *this
    turn* changed code and touched nothing under `docs/`, it blocks the stop and
    hands Claude the documentation checklist.

WHY IT COMPARES AGAINST A TURN SNAPSHOT AND NOT AGAINST `HEAD`
--------------------------------------------------------------
`git diff HEAD` answers "what is uncommitted", which is the wrong question. A
working tree routinely carries days of uncommitted work from earlier sessions —
a half-finished provider adapter, a vendored binary being tested. Diffing
against `HEAD` would fire on every single Stop for as long as that work sits
there, and a guard that fires on every turn is a guard that gets disabled in a
week. Snapshotting at `UserPromptSubmit` answers the question we actually care
about: "did *this exchange* change code?" — which is exactly the scope of the
documentation contract in CLAUDE.md. It also means the guard needs no git at
all to be correct; git is only ever used as a fast, .gitignore-aware way to
enumerate files (see `_list_files`).

WHY IT ONLY INTERRUPTS ONCE PER DISTINCT CHANGE SET
---------------------------------------------------
Sometimes the honest answer is "this needs no doc change" — a rename, a pure
refactor, a test-only edit. Asking a second time about the same edits trains the
reader to dismiss the checklist unread, which destroys its value. So the hash of
the *set of changed paths* is remembered in the snapshot file; a repeat Stop
over the same set passes silently. Change more code and the set changes, and the
guard is entitled to speak again.

WHICH HOOK CONTRACT THIS TARGETS
--------------------------------
Claude Code offers two ways for a `Stop` hook to block: exit code 2 with the
reason on stderr, or `{"decision": "block", "reason": "…"}` as JSON on stdout
with exit 0. Both are supported; this file deliberately uses the **JSON
decision**, because:

  * `reason` travels in one clearly-named field, whereas with exit 2 anything
    written to *stdout* is discarded and only stderr reaches Claude — an easy
    way to write a checklist nobody ever sees;
  * exit code 2 is the generic "blocking error" across every hook event, and
    several surfaces render it to the human as a hook *failure*. This hook is
    not failing. It is making a decision, and says so in the payload.

See `.claude/README.md` for the exit-2 equivalent if you ever need it.

FAILING OPEN IS A HARD REQUIREMENT
----------------------------------
A hook that can wedge a session is strictly worse than no hook: it costs the
developer their turn and their trust, over a reminder. Every path here is
wrapped, and every unexpected condition — no snapshot, unreadable JSON, no git,
a permission error, a bad clock — resolves to "exit 0, say nothing". The guard
is allowed to miss a change. It is not allowed to break a session.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

# Editing any of these means the behaviour of the app changed, which is what the
# documentation contract is about. `docs/` itself is snapshotted too — that is
# how a turn proves it already documented what it did.
CODE_ROOTS = ("src", "electron", "scripts", "test")
DOC_ROOTS = ("docs",)
ALL_ROOTS = CODE_ROOTS + DOC_ROOTS

SNAPSHOT_REL = os.path.join(".claude", ".docs-guard-snapshot.json")
SNAPSHOT_VERSION = 1

# Whole-file sha1 is what makes "touched but byte-identical" (a formatter that
# changed nothing, an editor that re-saved) not count as a change. But `test/`
# may hold media fixtures, and the hook has a 15 s budget shared with everything
# else, so anything past this size is judged on size+mtime alone. Source files
# are orders of magnitude below the cap; fixtures are the only thing that trips
# it, and a fixture that got rewritten really did change.
MAX_HASH_BYTES = 4 * 1024 * 1024

# Directories that are never source, even when a stray checkout or a build puts
# them under a watched root. Only consulted by the no-git fallback walk — the
# git path gets .gitignore semantics for free.
PRUNE_DIRS = frozenset({
    ".git", "node_modules", "dist", "out", "release", "coverage", ".vite",
    ".dev", "__pycache__", ".turbo", ".cache",
})

# `._*` are the AppleDouble sidecars macOS scatters over non-HFS volumes (the
# Windows checkout of this project is full of them). They mirror a real file's
# mtime, so without this they would double every reported change.
def _is_noise(name: str) -> bool:
    return name.startswith("._") or name == ".DS_Store" or name.endswith(".log")


CHECKLIST_HEADER = (
    "Documentation guard: this turn changed code under "
    + "/, ".join(CODE_ROOTS)
    + "/ and touched nothing under docs/."
)

CHECKLIST_BODY = """
Before you stop, work through this — it is the contract in CLAUDE.md §1, not a
suggestion:

1. docs/ — did behaviour change?
   A new module, IPC channel, engine or provider adapter, export format,
   setting, or keyboard shortcut gets documented in the matching file under
   docs/ (docs/architecture/, docs/engines/, docs/providers/). A changed
   invariant, default or policy gets the doc that states it amended. A deleted
   feature gets its section deleted, not left as history. Renamed or moved
   something? Fix every reference, and keep docs/README.md's index accurate.
   A doc asserting a rule the code no longer follows is worse than no doc.

2. docs/bugs/NNNN-short-slug.md — did you fix a bug?
   Write the entry if it took real investigation to find the root cause, if the
   fix looks unnecessary or over-complicated to a fresh reader, if a user
   reported it, if it was caused by ffmpeg / whisper.cpp / the OS rather than by
   our own logic, or if an earlier attempt at fixing it was wrong. Use
   docs/bugs/TEMPLATE.md, take the next free four-digit number, and add the row
   to docs/bugs/README.md. Write it now, in this turn, while the investigation
   is still in context — reconstructing a root cause from a diff next month
   produces a worthless entry.
   Skip it for typos, one-line lint fixes, pure refactors and cosmetics.

3. Genuinely nothing to document? Say so in one line and stop.
   This guard will not ask again about this same set of changes.

Do not touch a file under docs/ purely to silence this check.
"""


# --------------------------------------------------------------------------
# File enumeration
# --------------------------------------------------------------------------

def _git_files(project: Path) -> list[str] | None:
    """Tracked + untracked-but-not-ignored files under the watched roots.

    Tracked-only would be wrong: a brand new `electron/providers/deepgram.ts` is
    untracked until someone stages it, and that is precisely the change most
    worth documenting. `--others --exclude-standard` adds new files while still
    honouring .gitignore, so node_modules/ and out/ never enter the snapshot.

    Returns None — not an empty list — on any git trouble, so the caller can
    tell "git said nothing is here" from "git could not answer" and fall back.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(project), "ls-files", "-z",
             "--cached", "--others", "--exclude-standard", "--"] + list(ALL_ROOTS),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.decode("utf-8", "surrogateescape")
    return [p for p in out.split("\0") if p and not _is_noise(os.path.basename(p))]


def _walk_files(project: Path) -> list[str]:
    """Fallback for a checkout without git (or a git that refused to answer —
    the Windows volume aborts with "dubious ownership" until safe.directory is
    set globally, and the guard must keep working there)."""
    found: list[str] = []
    for root in ALL_ROOTS:
        base = project / root
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS and not d.startswith("._")]
            for name in filenames:
                if _is_noise(name):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, name), project)
                found.append(rel.replace(os.sep, "/"))
    return found


def _list_files(project: Path) -> list[str]:
    files = _git_files(project)
    if files is None:
        files = _walk_files(project)
    # Defensive: a pathspec typo or an odd git version must never widen the
    # guard's scope to the whole repo.
    return [f for f in files if f.split("/", 1)[0] in ALL_ROOTS]


# --------------------------------------------------------------------------
# Fingerprints
# --------------------------------------------------------------------------

def _sha1(path: Path) -> str | None:
    try:
        digest = hashlib.sha1()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _stat(path: Path) -> os.stat_result | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st if stat.S_ISREG(st.st_mode) else None


def _fingerprint(path: Path) -> dict[str, object] | None:
    st = _stat(path)
    if st is None:
        return None
    sha = _sha1(path) if st.st_size <= MAX_HASH_BYTES else None
    return {"mtime_ns": st.st_mtime_ns, "size": st.st_size, "sha1": sha}


def _snapshot_files(project: Path) -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    for rel in _list_files(project):
        fp = _fingerprint(project / rel)
        if fp is not None:
            out[rel] = fp
    return out


def _changed(project: Path, previous: dict[str, object]) -> set[str]:
    """Paths that differ from the snapshot: created, deleted or edited."""
    changed: set[str] = set()
    current = set(_list_files(project))
    for rel in current | set(previous.keys()):
        prev = previous.get(rel)
        st = _stat(project / rel)
        if not isinstance(prev, dict):
            # Unknown at snapshot time. Present now => created this turn.
            if st is not None:
                changed.add(rel)
            continue
        if st is None:
            changed.add(rel)          # deleted (or moved away) this turn
            continue
        if st.st_mtime_ns == prev.get("mtime_ns") and st.st_size == prev.get("size"):
            # Untouched. Skipping the hash here is what keeps the Stop pass
            # cheap — that is the whole reason mtime and size are stored
            # alongside the digest rather than the digest alone.
            continue
        prev_sha = prev.get("sha1")
        if isinstance(prev_sha, str):
            if _sha1(project / rel) == prev_sha:
                continue              # touched, but byte-identical: not a change
        changed.add(rel)
    return changed


def _set_hash(paths: set[str]) -> str:
    return hashlib.sha1("\n".join(sorted(paths)).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# Snapshot persistence
# --------------------------------------------------------------------------

def _read_snapshot(path: Path) -> dict[str, object] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != SNAPSHOT_VERSION:
        return None
    return data


def _write_snapshot(path: Path, files: dict[str, dict[str, object]],
                    last_blocked: object) -> None:
    """Written via a temp file + rename, because the hook can be killed at its
    15 s timeout mid-write; a truncated snapshot would then be unparseable, and
    an unparseable snapshot silently disarms the guard for a whole turn."""
    payload = {
        "version": SNAPSHOT_VERSION,
        "taken_at": time.time(),
        "last_blocked": last_blocked if isinstance(last_blocked, str) else None,
        "files": files,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1, sort_keys=True)
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------

def _project_dir() -> Path:
    """CLAUDE_PROJECT_DIR when the harness sets it, otherwise derived from this
    file's own location (`<project>/.claude/hooks/docs-guard.py`) so the hook is
    still correct when run by hand for testing."""
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        candidate = Path(env)
        if (candidate / ".claude").is_dir():
            return candidate
    return Path(__file__).resolve().parents[2]


def _disabled() -> bool:
    value = os.environ.get("DOCS_GUARD", "").strip().lower()
    return value in {"0", "off", "false", "no"}


def _hook_input() -> dict[str, object]:
    """Hook payload from stdin. A tty means somebody is running this by hand —
    reading would block until the timeout kills us, so don't."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _format_reason(changed_code: set[str]) -> str:
    listed = sorted(changed_code)
    shown = listed[:20]
    lines = [CHECKLIST_HEADER, "", "Changed this turn (%d file%s):" % (
        len(listed), "" if len(listed) == 1 else "s")]
    lines += ["  " + rel for rel in shown]
    if len(listed) > len(shown):
        lines.append("  … and %d more" % (len(listed) - len(shown)))
    lines.append(CHECKLIST_BODY.rstrip("\n"))
    return "\n".join(lines)


def run(argv: list[str]) -> str | None:
    """Returns the block reason, or None to let the turn end.

    Never calls sys.exit and never prints: the caller owns the process exit so
    that a bug in here can only ever produce "no opinion", never a wedged
    session.
    """
    if _disabled():
        return None

    project = _project_dir()
    snapshot_path = project / SNAPSHOT_REL

    if "--snapshot" in argv:
        # UserPromptSubmit. Anything this branch writes to stdout is injected
        # into Claude's context, so it writes nothing at all.
        existing = _read_snapshot(snapshot_path)
        carried = existing.get("last_blocked") if existing else None
        _write_snapshot(snapshot_path, _snapshot_files(project), carried)
        return None

    payload = _hook_input()

    # The harness sets this when Claude is only still running *because* a Stop
    # hook blocked it. Blocking again from inside that continuation is how a
    # session ends up looping forever, so this is a hard floor: one interruption
    # per turn, no matter what else changed.
    if payload.get("stop_hook_active") is True:
        return None

    snapshot = _read_snapshot(snapshot_path)
    if snapshot is None:
        # No baseline (hook installed mid-session, snapshot corrupt, or the
        # UserPromptSubmit run was killed). We cannot know what this turn did,
        # so we say nothing — and lay down a baseline so the next turn can.
        _write_snapshot(snapshot_path, _snapshot_files(project), None)
        return None

    previous = snapshot.get("files")
    if not isinstance(previous, dict):
        return None

    changed = _changed(project, previous)
    changed_code = {p for p in changed if p.split("/", 1)[0] in CODE_ROOTS}
    if not changed_code:
        return None                    # read-only turn: never fires
    if any(p.split("/", 1)[0] in DOC_ROOTS for p in changed):
        return None                    # docs moved too; the contract is met

    fired = _set_hash(changed_code)
    if snapshot.get("last_blocked") == fired:
        return None                    # already asked about exactly these edits

    # Remember before returning, so the answer "nothing to document here" holds
    # even if the very next thing that happens is another Stop.
    _write_snapshot(snapshot_path, previous, fired)
    return _format_reason(changed_code)


def main() -> None:
    try:
        reason = run(sys.argv[1:])
    except BaseException:  # noqa: BLE001 - fail open, always. See module docstring.
        reason = None
    if reason:
        json.dump({"decision": "block", "reason": reason}, sys.stdout)
        sys.stdout.write("\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
