import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMeta, isMetaBoardMeta } from '../lib/envelope.js'

test('makeMeta 产出完整信封,省略 derivedFrom 时不带该键', () => {
  assert.deepEqual(
    makeMeta({ subject: 'topic:a', kind: 'research', payload: { n: 1 } }),
    { subject: 'topic:a', kind: 'research', payload: { n: 1 } },
  )
})

test('makeMeta 保留 derivedFrom', () => {
  const m = makeMeta({ subject: 'topic:a', kind: 'draft', derivedFrom: ['c1'], payload: {} })
  assert.deepEqual(m.derivedFrom, ['c1'])
})

test('makeMeta 对不在 KINDS 里的 kind 抛错', () => {
  assert.throws(() => {
    makeMeta({ subject: 'topic:a', kind: 'nope', payload: {} })
  })
})

test('isMetaBoardMeta 只认结构完整的信封', () => {
  assert.equal(isMetaBoardMeta({ subject: 'topic:a', kind: 'draft', payload: {} }), true)
  assert.equal(isMetaBoardMeta({ subject: 'topic:a', kind: 'draft' }), false)
  assert.equal(isMetaBoardMeta({ kind: 'draft', payload: {} }), false)
  assert.equal(isMetaBoardMeta({ subject: 'a', kind: 'nope', payload: {} }), false)
  assert.equal(isMetaBoardMeta(null), false)
  assert.equal(isMetaBoardMeta('x'), false)
})
