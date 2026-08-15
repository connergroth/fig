import { AGENT_NAME } from "./config";

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(msg: string): void {
  console.log(`[${ts()}] ${AGENT_NAME}: ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[${ts()}] ${AGENT_NAME}: WARN ${msg}`);
}

export function err(msg: string): void {
  console.error(`[${ts()}] ${AGENT_NAME}: ERROR ${msg}`);
}
