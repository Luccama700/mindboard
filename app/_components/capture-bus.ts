"use client";

// Tiny window-scoped event bus that decouples the global Dock capture input
// from whichever task list is currently on screen. The Dock emits, lists
// subscribe and apply their own optimistic updates.

import type { Task } from "./types";

const OPTIMISTIC = "mindboard:task-optimistic";
const REPLACE = "mindboard:task-replace";
const REMOVE = "mindboard:task-remove";

export function emitTaskOptimistic(task: Task) {
  window.dispatchEvent(new CustomEvent(OPTIMISTIC, { detail: task }));
}

export function emitTaskReplace(tempId: string, task: Task) {
  window.dispatchEvent(new CustomEvent(REPLACE, { detail: { tempId, task } }));
}

// The create failed: take the optimistic card back off the list.
export function emitTaskRemove(tempId: string) {
  window.dispatchEvent(new CustomEvent(REMOVE, { detail: { tempId } }));
}

export function subscribeCapture(handlers: {
  onOptimisticAdd: (task: Task) => void;
  onReplace: (tempId: string, task: Task) => void;
  onRemove?: (tempId: string) => void;
}): () => void {
  const onAdd = (e: Event) =>
    handlers.onOptimisticAdd((e as CustomEvent<Task>).detail);
  const onReplace = (e: Event) => {
    const { tempId, task } = (
      e as CustomEvent<{ tempId: string; task: Task }>
    ).detail;
    handlers.onReplace(tempId, task);
  };
  const onRemove = (e: Event) =>
    handlers.onRemove?.((e as CustomEvent<{ tempId: string }>).detail.tempId);
  window.addEventListener(OPTIMISTIC, onAdd);
  window.addEventListener(REPLACE, onReplace);
  window.addEventListener(REMOVE, onRemove);
  return () => {
    window.removeEventListener(OPTIMISTIC, onAdd);
    window.removeEventListener(REPLACE, onReplace);
    window.removeEventListener(REMOVE, onRemove);
  };
}
