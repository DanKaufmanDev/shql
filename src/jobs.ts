import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface JobContext {
  runId: string;
  signal: AbortSignal;
}
export interface JobDefinition {
  name: string;
  run(context: JobContext): Promise<unknown>;
  every?: string | number;
  retries?: number;
  timeoutMs?: number;
}
export interface JobRun {
  id: string;
  job: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  attempts: number;
  error?: string;
}

function duration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid job interval ${value}.`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]]!;
}

export class JobRunner {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly runs: JobRun[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly historyPath: string;
  constructor(historyPath = ".shql/job-runs.json") {
    this.historyPath = historyPath;
  }

  register(job: JobDefinition): this {
    this.jobs.set(job.name, job);
    return this;
  }
  list(): string[] {
    return [...this.jobs.keys()];
  }
  history(job?: string): JobRun[] {
    return this.runs.filter((run) => !job || run.job === job).map((run) => ({ ...run }));
  }

  async load(): Promise<void> {
    try {
      this.runs.push(...(JSON.parse(await readFile(this.historyPath, "utf8")) as JobRun[]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, `${JSON.stringify(this.runs.slice(-1000), null, 2)}\n`, "utf8");
  }

  async run(name: string): Promise<JobRun> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}.`);
    const record: JobRun = {
      id: randomUUID(),
      job: name,
      status: "running",
      startedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.runs.push(record);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Job ${name} timed out.`)),
      job.timeoutMs ?? 300_000,
    );
    try {
      for (let attempt = 0; attempt <= (job.retries ?? 0); attempt++) {
        record.attempts = attempt + 1;
        try {
          await job.run({ runId: record.id, signal: controller.signal });
          record.status = "succeeded";
          break;
        } catch (error) {
          if (attempt >= (job.retries ?? 0)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
      record.finishedAt = new Date().toISOString();
      await this.save();
    }
    return { ...record };
  }

  start(): void {
    for (const job of this.jobs.values()) {
      if (job.every === undefined || this.timers.has(job.name)) continue;
      this.timers.set(
        job.name,
        setInterval(() => void this.run(job.name), duration(job.every)),
      );
    }
  }
  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
