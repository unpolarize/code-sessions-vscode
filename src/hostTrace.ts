/**
 * Host-trace spans (architecture tools/observability.md).
 * Pure except the optional async file sink — no vscode.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type TraceSrc = 'cb' | 'csv' | 'cs';
export type TraceKind = 'start' | 'mark' | 'end';

export interface TraceMark {
  name: string;
  durMs: number;
  atMs: number;
  detail?: Record<string, unknown>;
}

export interface TraceEvent {
  ts: number;
  src: TraceSrc;
  ver: string;
  name: string;
  id: string;
  t: TraceKind;
  mark?: string;
  durMs?: number;
  atMs?: number;
  totalMs?: number;
  slow?: boolean;
  marks?: TraceMark[];
  detail?: Record<string, unknown>;
}

export type TraceSink = (human: string, jsonLine: string, ev: TraceEvent) => void;

export const SLOW_MS: Record<string, number> = {
  'cb.newConversation': 300,
  'cb.hydrate': 100,
  'cb.activate': 500,
  'cb.sidebar.resolve': 300,
  'cb.deserialize': 500,
  'csv.activate': 1000,
  'csv.index': 200,
  'csv.daemon.hello': 2500
};

export const DEFAULT_TRACE_PATH = join(homedir(), '.sessions', '.daemon', 'host-trace.ndjson');
export const TRACE_ROTATE_BYTES = 2 * 1024 * 1024;

let ctx: { src: TraceSrc; ver: string } = { src: 'csv', ver: '?' };
const sinks: TraceSink[] = [];
const taskStack: string[] = [];
const RING_MAX = 200;
const ring: TraceEvent[] = [];
let fileChain: Promise<void> = Promise.resolve();

export function initTrace(src: TraceSrc, ver: string): void {
  ctx = { src, ver };
}

export function addTraceSink(fn: TraceSink): () => void {
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function setHostTask(name: string): void {
  taskStack.push(name);
}

export function clearHostTask(): void {
  taskStack.pop();
}

export function getHostTask(): string {
  return taskStack[taskStack.length - 1] ?? '';
}

export function recentTraces(): TraceEvent[] {
  return ring.slice();
}

export function slowBudget(name: string): number {
  return SLOW_MS[name] ?? 300;
}

export function newTraceId(): string {
  return randomBytes(4).toString('hex');
}

export function formatTraceHuman(ev: TraceEvent): string {
  if (ev.t === 'start') return `[trace] START ${ev.name} ${ev.id}`;
  if (ev.t === 'mark') {
    const d = ev.durMs ?? 0;
    return `[trace] +${Math.round(d)}ms ${ev.mark ?? ''}`;
  }
  const slow = ev.slow ? ' SLOW' : '';
  const marks = (ev.marks ?? []).map((m) => `${m.name}:${Math.round(m.durMs)}`).join(' ');
  const tail = marks ? ` ${marks}` : '';
  return `[trace] DONE ${ev.name} ${Math.round(ev.totalMs ?? 0)}ms${slow}${tail}`;
}

export function formatTraceJson(ev: TraceEvent): string {
  return JSON.stringify(ev);
}

export function emitTrace(ev: TraceEvent): void {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  const human = formatTraceHuman(ev);
  const jsonLine = formatTraceJson(ev);
  for (const s of sinks) {
    try {
      s(human, jsonLine, ev);
    } catch {
      /* sink errors must not break the host */
    }
  }
}

export class Span {
  readonly id: string;
  readonly name: string;
  readonly t0: number;
  private last: number;
  readonly marks: TraceMark[] = [];

  constructor(
    name: string,
    id?: string,
    private readonly now: () => number = Date.now
  ) {
    this.name = name;
    this.id = id ?? newTraceId();
    this.t0 = this.now();
    this.last = this.t0;
    setHostTask(name);
    emitTrace({
      ts: this.t0,
      src: ctx.src,
      ver: ctx.ver,
      name: this.name,
      id: this.id,
      t: 'start'
    });
  }

  mark(mark: string, detail?: Record<string, unknown>): number {
    const n = this.now();
    const durMs = n - this.last;
    const atMs = n - this.t0;
    const rec: TraceMark = { name: mark, durMs, atMs };
    if (detail) rec.detail = detail;
    this.marks.push(rec);
    this.last = n;
    if (taskStack.length) taskStack[taskStack.length - 1] = `${this.name}.${mark}`;
    else setHostTask(`${this.name}.${mark}`);
    emitTrace({
      ts: n,
      src: ctx.src,
      ver: ctx.ver,
      name: this.name,
      id: this.id,
      t: 'mark',
      mark,
      durMs,
      atMs,
      detail
    });
    return durMs;
  }

  end(detail?: Record<string, unknown>): number {
    const n = this.now();
    const totalMs = n - this.t0;
    const slow = totalMs >= slowBudget(this.name);
    emitTrace({
      ts: n,
      src: ctx.src,
      ver: ctx.ver,
      name: this.name,
      id: this.id,
      t: 'end',
      totalMs,
      slow,
      marks: this.marks,
      detail
    });
    clearHostTask();
    return totalMs;
  }
}

export function startSpan(name: string): Span {
  return new Span(name);
}

export function startFileSink(path = DEFAULT_TRACE_PATH, maxBytes = TRACE_ROTATE_BYTES): () => void {
  const sink: TraceSink = (_human, jsonLine) => {
    fileChain = fileChain.then(() => writeTraceFile(path, jsonLine, maxBytes)).catch(() => {});
  };
  return addTraceSink(sink);
}

async function writeTraceFile(path: string, jsonLine: string, maxBytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const st = await stat(path);
    if (st.size > maxBytes) {
      await rename(path, `${path}.prev`).catch(() => {});
    }
  } catch {
    /* missing */
  }
  await appendFile(path, `${jsonLine}\n`);
}

/** Test helper: drop sinks / ring / task stack. */
export function resetTraceForTests(): void {
  sinks.length = 0;
  ring.length = 0;
  taskStack.length = 0;
  ctx = { src: 'cb', ver: 'test' };
}
