/**
 * A generic undo/redo stack: past/present/future over any value.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 *
 * This exists because every operation in src/core/transcript.js is pure and
 * returns a new object -- so an undo stack for a Transcript is just a list of
 * the objects already produced, sharing whatever those operations already
 * shared. Nothing here is transcript-specific; it is generic over T so it can
 * be tested and reasoned about on its own.
 */

/**
 * @template T
 * @typedef {{
 *   push(value: T): void,
 *   undo(): T | undefined,
 *   redo(): T | undefined,
 *   canUndo(): boolean,
 *   canRedo(): boolean,
 *   current(): T,
 * }} UndoStack
 */

/**
 * @template T
 * @param {T} initial
 * @returns {UndoStack<T>}
 */
export function createUndoStack(initial) {
  /** @type {T[]} */
  let past = []
  let present = initial
  /** @type {T[]} */
  let future = []

  return {
    push(value) {
      past.push(present)
      present = value
      // A push after an undo means the user chose a new future, not the one
      // they had undone away -- keeping it around would make redo bring back
      // an edit that a later, different edit already superseded.
      future = []
    },

    undo() {
      if (past.length === 0) return undefined
      future.push(present)
      present = /** @type {T} */ (past.pop())
      return present
    },

    redo() {
      if (future.length === 0) return undefined
      past.push(present)
      present = /** @type {T} */ (future.pop())
      return present
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    current: () => present,
  }
}
