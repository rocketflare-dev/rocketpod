/**
 * The Claude Code nudge hook (`scripts/changelog-nudge.mjs`) and its pure half,
 * `scripts/lib/nudge-lib.mjs`.
 *
 * The property that matters most is the OUTPUT SHAPE: a `PreToolUse` hook's plain stdout never
 * reaches Claude, so a nudge that prints text is a nudge nobody sees.
 */
import { describe, expect, it } from 'vitest'
import { commitsAll, hookJson, isGitCommit } from '../../../../scripts/lib/nudge-lib.mjs'

describe('nudge-lib', () => {
  it('recognises a commit, and a commit that stages tracked changes itself', () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true)
    expect(isGitCommit('git add -A && git commit -q -F -')).toBe(true)
    expect(isGitCommit('git status')).toBe(false)
    expect(commitsAll('git commit -am "Release 1.0.0"')).toBe(true)
    expect(commitsAll('git commit -a -m x')).toBe(true)
    expect(commitsAll('git commit -m "a -b"')).toBe(false)
  })

  it('writes the shape Claude reads — additionalContext, never bare text', () => {
    const out = JSON.parse(hookJson('line one\nline two', 'notice'))
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'line one\nline two' },
      systemMessage: 'notice',
    })
    expect(JSON.parse(hookJson('only line')).systemMessage).toBe('only line')
  })
})
