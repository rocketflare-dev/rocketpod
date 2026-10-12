/**
 * The pure half of the Claude Code nudge hook (`changelog-nudge.mjs`).
 *
 * **No imports, on purpose.** Everything here stands alone rather than reaching into
 * `plugin-lib.mjs` or `upgrade-lib.mjs`.
 *
 * One fact every hook here depends on: a `PreToolUse` hook's plain stdout goes to the debug log,
 * NOT to Claude. Only `hookSpecificOutput.additionalContext` reaches the model, and `systemMessage`
 * shows in the transcript. `hookJson` is the one place that shape is written.
 */

/** `true` when a Bash command runs `git commit`. */
export function isGitCommit(command) {
  return typeof command === 'string' && /\bgit\s+commit\b/.test(command)
}

/** `true` for `git commit -a` / `-am …` — tracked changes are staged by the commit itself. */
export function commitsAll(command) {
  return typeof command === 'string' && /\bcommit\b[^|;&]*\s-[a-zA-Z]*a/.test(command)
}

/** The hook's stdout: context for Claude, plus a one-line notice in the transcript. */
export function hookJson(message, notice) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
    systemMessage: notice ?? message.split('\n')[0],
  })
}
