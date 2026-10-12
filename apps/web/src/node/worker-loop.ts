/**
 * The `worker` mode's loop (M2 placeholder). M3 replaces the body with the pg-boss consumer (jobs,
 * cron) and M4 adds the OpenWorkflow worker; the lifecycle around it — start, report, stop on
 * SIGTERM and let in-flight work finish — is the contract those keep.
 */
export interface WorkerLoop {
  /** Stop taking new work and resolve once in-flight work has finished. */
  stop(): Promise<void>
}

export interface WorkerLoopOptions {
  log: (message: string) => void
  /** How often the placeholder reports it is alive. */
  heartbeatMs?: number
}

export function startWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  const { log, heartbeatMs = 60_000 } = options
  log('worker: started (no consumers yet — jobs and cron arrive with pg-boss in M3)')
  const timer = setInterval(() => log('worker: alive'), heartbeatMs)
  timer.unref()
  let stopped: Promise<void> | undefined
  return {
    stop() {
      stopped ??= (async () => {
        clearInterval(timer)
        log('worker: stopped')
      })()
      return stopped
    },
  }
}
