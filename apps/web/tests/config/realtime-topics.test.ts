/**
 * The realtime TOPIC registry (`@rocketpod/shared/realtime` § Topics) as pure functions over
 * FIXTURE plugins — core ships no topic kind and no installed plugin need declare one, so a
 * check that only ran over the installed set would prove nothing. What the hub does with the
 * answers is `tests/api/node-realtime.test.ts`.
 */
import {
  buildRealtimeTopicRegistry,
  canSubscribeTopic,
  parseRealtimeTopic,
  platformTopic,
  REALTIME_TOPICS,
  realtimeClientMessageSchema,
  realtimeTopicSubjects,
  tenantTopic,
} from '@rocketpod/shared/realtime'
import { describe, expect, it } from 'vitest'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

const orders = {
  id: 'orders',
  realtimeTopics: [
    { prefix: 'orders.order', subject: 'Order' },
    { prefix: 'orders', subject: 'OrderBoard' },
    { prefix: 'orders.import', subject: 'Order', scope: 'platform' as const },
  ],
}
const registry = buildRealtimeTopicRegistry([orders])

describe('buildRealtimeTopicRegistry', () => {
  it('refuses a prefix outside the plugin’s own namespace, or in the kit’s', () => {
    for (const prefix of ['billing.invoice', 'ordersx', 'kit', 'kit.runs']) {
      expect(
        () =>
          buildRealtimeTopicRegistry([
            { id: 'orders', realtimeTopics: [{ prefix, subject: 'Order' }] },
          ]),
        prefix
      ).toThrow(/namespace/)
    }
    // Core may not take the kit namespace either.
    expect(() =>
      buildRealtimeTopicRegistry([], [{ prefix: 'kit.runs', subject: 'AgentRun' }])
    ).toThrow(/reserved kit namespace/)
  })

  it('refuses a malformed prefix, a kind with no subject, and a prefix declared twice', () => {
    const one = (prefix: string, subject = 'Order') => [
      { id: 'orders', realtimeTopics: [{ prefix, subject }] },
    ]
    expect(() => buildRealtimeTopicRegistry(one('orders:order'))).toThrow(/malformed/)
    expect(() => buildRealtimeTopicRegistry(one('Orders.order'))).toThrow(/malformed/)
    expect(() => buildRealtimeTopicRegistry(one('orders.order', ''))).toThrow(/no subject/)
    expect(() =>
      buildRealtimeTopicRegistry([orders], [{ prefix: 'orders.order', subject: 'Order' }])
    ).toThrow(/declared twice/)
  })

  it('builds the installed registry without throwing, and asks /ws only about its subjects', () => {
    // Evaluated at import: a bad declaration by an installed plugin fails here, by name.
    expect(REALTIME_TOPICS).toBeInstanceOf(Map)
    expect(realtimeTopicSubjects(registry).sort()).toEqual(['Order', 'OrderBoard'])
  })
})

describe('parseRealtimeTopic', () => {
  it('reads a tenant topic and a platform topic of a registered kind', () => {
    expect(parseRealtimeTopic(`orders.order:${TENANT}:o-1`, registry)).toMatchObject({
      tenantId: TENANT,
      id: 'o-1',
      definition: { subject: 'Order' },
    })
    expect(parseRealtimeTopic('orders.import:batch_7', registry)).toMatchObject({ id: 'batch_7' })
  })

  it('knows nothing it was not told: wrong shape, unknown kind, oversize', () => {
    for (const topic of [
      `orders.order:${TENANT}`, // no id
      `orders.order:not-a-uuid:o-1`,
      `orders.order:${TENANT}:o-1:extra`,
      `orders.order:${TENANT}:a b`,
      `orders.import:${TENANT}:o-1`, // a platform kind carries no tenant
      `orders.refund:${TENANT}:o-1`, // never declared
      `orders.order:${TENANT}:${'x'.repeat(300)}`,
      '',
    ]) {
      expect(parseRealtimeTopic(topic, registry), topic).toBeNull()
    }
  })
})

describe('canSubscribeTopic', () => {
  const owner = { tenantId: TENANT, canRead: ['Order', 'OrderBoard'] }
  const topic = `orders.order:${TENANT}:o-1`

  it('lets a member of the topic’s tenant who may read its subject subscribe', () => {
    expect(canSubscribeTopic(owner, topic, registry)).toBe(true)
    expect(canSubscribeTopic(owner, `orders:${TENANT}:board`, registry)).toBe(true)
  })

  it('refuses a member without `read` on the subject', () => {
    expect(canSubscribeTopic({ tenantId: TENANT, canRead: ['OrderBoard'] }, topic, registry)).toBe(
      false
    )
    expect(canSubscribeTopic({ tenantId: TENANT }, topic, registry)).toBe(false)
  })

  it('refuses a topic naming another tenant, whoever asks — a global admin too', () => {
    const other = `orders.order:${OTHER}:o-1`
    expect(canSubscribeTopic(owner, other, registry)).toBe(false)
    expect(canSubscribeTopic({ ...owner, globalAdmin: true }, other, registry)).toBe(false)
  })

  it('refuses a topic from a plugin that is not installed', () => {
    // The same string the orders plugin would publish, against a deployment without it.
    const withoutOrders = buildRealtimeTopicRegistry([{ id: 'billing' }])
    expect(canSubscribeTopic(owner, topic, withoutOrders)).toBe(false)
  })

  it('gives a platform topic to a global admin who may read its subject, and nobody else', () => {
    const platform = 'orders.import:batch_7'
    expect(canSubscribeTopic(owner, platform, registry)).toBe(false)
    expect(canSubscribeTopic({ ...owner, globalAdmin: true }, platform, registry)).toBe(true)
    expect(
      canSubscribeTopic({ tenantId: TENANT, globalAdmin: true, canRead: [] }, platform, registry)
    ).toBe(false)
  })
})

describe('tenantTopic / platformTopic', () => {
  it('build a topic the parser reads back, and refuse an unregistered or wrong-scope kind', () => {
    const topic = tenantTopic('orders.order', TENANT, 'o-1', registry)
    expect(canSubscribeTopic(orderReader(), topic, registry)).toBe(true)
    expect(() => tenantTopic('orders.refund', TENANT, 'o-1', registry)).toThrow(/not a registered/)
    expect(() => tenantTopic('orders.import', TENANT, 'o-1', registry)).toThrow(/not a registered/)
    expect(() => tenantTopic('orders.order', 'tenant-a', 'o-1', registry)).toThrow(
      /not a registered/
    )
    expect(platformTopic('orders.import', 'b-1', registry)).toBe('orders.import:b-1')
    expect(() => platformTopic('orders.order', 'b-1', registry)).toThrow(/not a registered/)
  })
})

function orderReader() {
  return { tenantId: TENANT, canRead: ['Order'] }
}

describe('realtimeClientMessageSchema', () => {
  it('accepts the three frames a socket may send and nothing else', () => {
    expect(realtimeClientMessageSchema.safeParse({ type: 'ping' }).success).toBe(true)
    expect(
      realtimeClientMessageSchema.safeParse({ type: 'subscribe', topic: 'a:b:c' }).success
    ).toBe(true)
    expect(realtimeClientMessageSchema.safeParse({ type: 'subscribe' }).success).toBe(false)
    expect(realtimeClientMessageSchema.safeParse({ type: 'broadcast', topic: 'x' }).success).toBe(
      false
    )
    expect(
      realtimeClientMessageSchema.safeParse({ type: 'subscribe', topic: 'x'.repeat(300) }).success
    ).toBe(false)
  })
})
