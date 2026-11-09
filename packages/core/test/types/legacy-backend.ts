import type {
  BulkEnqueueItem,
  EnqueueOptions,
  EnqueueResult,
  JobBackend,
  JobDefinition,
  JobHandler,
  QueueDefinition,
  RegisterHandlerOptions,
} from "../../src/index.js";

class RecordingBackend {
  readonly enqueueCalls: {
    job: JobDefinition<unknown>;
    payload: unknown;
    options?: EnqueueOptions;
  }[] = [];
  readonly enqueueBulkCalls: {
    job: JobDefinition<unknown>;
    items: BulkEnqueueItem<unknown>[];
  }[] = [];
  readonly handlerCalls: {
    job: JobDefinition<unknown>;
    handler: JobHandler<unknown>;
    options?: RegisterHandlerOptions;
  }[] = [];
  readonly lifecycleCalls: { method: string; args: unknown[] }[] = [];

  async enqueue<TPayload>(
    job: JobDefinition<TPayload>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    this.enqueueCalls.push({
      job: job as JobDefinition<unknown>,
      payload,
      options,
    });

    return {
      jobId: options?.jobId ?? "generated-id",
      name: options?.jobName ?? job.name,
    };
  }

  async enqueueBulk<TPayload>(
    job: JobDefinition<TPayload>,
    items: BulkEnqueueItem<TPayload>[],
  ): Promise<EnqueueResult[]> {
    this.enqueueBulkCalls.push({
      job: job as JobDefinition<unknown>,
      items: items as BulkEnqueueItem<unknown>[],
    });

    return items.map((item, index) => ({
      jobId: item.options?.jobId ?? `generated-id-${index}`,
      name: item.options?.jobName ?? job.name,
    }));
  }

  registerHandler<TPayload>(
    job: JobDefinition<TPayload>,
    handler: JobHandler<TPayload>,
    options?: RegisterHandlerOptions,
  ): void {
    this.handlerCalls.push({
      job: job as JobDefinition<unknown>,
      handler: handler as JobHandler<unknown>,
      options,
    });
  }

  async start(): Promise<void> {
    this.lifecycleCalls.push({ method: "start", args: [] });
  }

  async stop(options?: { timeout?: number }): Promise<void> {
    this.lifecycleCalls.push({ method: "stop", args: [options] });
  }

  async pauseAll(): Promise<void> {
    this.lifecycleCalls.push({ method: "pauseAll", args: [] });
  }

  async resumeAll(): Promise<void> {
    this.lifecycleCalls.push({ method: "resumeAll", args: [] });
  }

  async pauseQueue(queue: QueueDefinition): Promise<void> {
    this.lifecycleCalls.push({ method: "pauseQueue", args: [queue] });
  }

  async resumeQueue(queue: QueueDefinition): Promise<void> {
    this.lifecycleCalls.push({ method: "resumeQueue", args: [queue] });
  }
}

const backend: JobBackend = new RecordingBackend();
void backend;
