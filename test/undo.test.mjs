/**
 * The generic undo/redo stack's behaviour.
 *
 * Offline and instant. Nothing here touches the network, the DOM, or the disk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUndoStack } from '../src/core/undo.js'

test('current() starts at the initial value', () => {
  const stack = createUndoStack('a')
  assert.equal(stack.current(), 'a')
  assert.equal(stack.canUndo(), false)
  assert.equal(stack.canRedo(), false)
})

test('push moves current() forward and makes undo available', () => {
  const stack = createUndoStack('a')
  stack.push('b')
  assert.equal(stack.current(), 'b')
  assert.equal(stack.canUndo(), true)
  assert.equal(stack.canRedo(), false)
})

test('undo returns the previous value and undo at the bottom is a no-op', () => {
  const stack = createUndoStack('a')
  stack.push('b')
  stack.push('c')

  assert.equal(stack.undo(), 'b')
  assert.equal(stack.undo(), 'a')
  assert.equal(stack.canUndo(), false)

  // A drag or keystroke that lands back at the start is inert, not an error.
  assert.equal(stack.undo(), undefined)
  assert.equal(stack.current(), 'a')
})

test('redo replays an undone value, and redo with nothing undone is a no-op', () => {
  const stack = createUndoStack('a')
  stack.push('b')
  stack.undo()

  assert.equal(stack.redo(), 'b')
  assert.equal(stack.canRedo(), false)
  assert.equal(stack.redo(), undefined)
  assert.equal(stack.current(), 'b')
})

test('a push after an undo discards the redone-away future', () => {
  const stack = createUndoStack('a')
  stack.push('b')
  stack.undo() // back to 'a', 'b' sits in future

  stack.push('c') // a new edit, not the one that was undone
  assert.equal(stack.current(), 'c')
  assert.equal(stack.canRedo(), false)
  assert.equal(stack.redo(), undefined)
})
