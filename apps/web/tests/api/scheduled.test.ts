import { describe, expect, it } from 'vitest'
import { dispatchScheduled, type ScheduledTask } from '@/api/scheduled'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

describe('scheduled dispatcher', () => {
  it('runs the tasks registered for event.cron and reports each', async () => {
    const env = createTestEnv()
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('0 4 * * *', env, ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([
      expect.objectContaining({ cron: '0 4 * * *', task: 'pruneExpired', status: 'ok' }),
      expect.objectContaining({ cron: '0 4 * * *', task: 'pruneAiSpans', status: 'ok' }),
    ])
  })

  it('isolates a failing task from the others', async () => {
    const boom: ScheduledTask = {
      name: 'boom',
      run: async () => {
        throw new Error('nope')
      },
    }
    const ran: string[] = []
    const after: ScheduledTask = {
      name: 'after',
      run: async ({ db, logger }) => {
        expect(db).toBeDefined()
        expect(logger).toBeDefined()
        ran.push('after')
      },
    }
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('* * * * *', createTestEnv(), ctx, {
      '* * * * *': [boom, after],
    })
    await waitOnExecutionContext(ctx)
    expect(reports.map(r => `${r.task}:${r.status}`)).toEqual(['boom:failed', 'after:ok'])
    expect(ran).toEqual(['after'])
  })

  it('an unknown cron runs nothing', async () => {
    const ctx = createExecutionContext()
    expect(await dispatchScheduled('59 23 31 12 *', createTestEnv(), ctx)).toEqual([])
  })
})
