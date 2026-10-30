import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startVisiblePolling } from '../src/visiblePolling.ts'
function fixture(visible = true) {
  const listeners = new Set(), timers = new Map()
  let nextId = 0
  const page = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); listeners.add(callback) },
    removeEventListener(name, callback) { listeners.delete(callback) },
  }
  const clock = {
    setInterval(callback) { const id = ++nextId; timers.set(id, callback); return id },
    clearInterval(id) { timers.delete(id) },
  }
  return { page, clock, timers, listeners,
    visibility(state) { page.visibilityState = state; for (const callback of listeners) callback() },
    tick() { for (const callback of [...timers.values()]) callback() },
  }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
test('hidden tabs do not poll; returning refreshes and cleanup stops work', async () => {
  const f = fixture(false), calls = []
  const stop = startVisiblePolling(async initial => { calls.push(initial) }, 3000, f.page, f.clock)
  f.tick(); assert.deepEqual(calls, []); assert.equal(f.timers.size, 0)
  f.visibility('visible'); await settle(); assert.deepEqual(calls, [true])
  f.tick(); await settle(); assert.deepEqual(calls, [true, false])
  f.visibility('hidden'); f.tick(); assert.equal(f.timers.size, 0); assert.equal(calls.length, 2)
  f.visibility('visible'); await settle(); assert.deepEqual(calls, [true, false, false])
  stop(); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0)
  f.visibility('visible'); f.tick(); assert.equal(calls.length, 3)
})
test('slow requests do not overlap, including hide/show while running', async () => {
  const f = fixture(), calls = []
  let finish
  const stop = startVisiblePolling(initial => { calls.push(initial); return new Promise(resolve => { finish = resolve }) }, 4000, f.page, f.clock)
  f.tick(); f.tick(); f.visibility('hidden'); f.visibility('visible'); assert.equal(calls.length, 1)
  finish(); await settle(); f.tick(); assert.deepEqual(calls, [true, false])
  stop(); finish(); await settle(); assert.equal(f.timers.size, 0)
})
test('visibility-only refreshes do not add a polling timer', async () => {
  const f = fixture(); let calls = 0
  const stop = startVisiblePolling(async () => { calls++ }, undefined, f.page, f.clock)
  await settle(); assert.equal(calls, 1); assert.equal(f.timers.size, 0)
  f.visibility('hidden'); f.visibility('visible'); await settle(); assert.equal(calls, 2)
  stop()
})
