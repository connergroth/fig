import { AsyncLocalStorage } from "node:async_hooks";

interface AgentPassContext {
  /** True for scheduler/proactive/watch-style one-shot passes with no live user waiting. */
  headless: boolean;
  /** Human-readable run label for logs/debugging. */
  label?: string;
}

const storage = new AsyncLocalStorage<AgentPassContext>();

export function withHeadlessAgentPass<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ headless: true, label }, fn);
}

export function isHeadlessAgentPass(): boolean {
  return storage.getStore()?.headless === true;
}

