---
"@mokurokujs/core": minor
"@mokurokujs/bullmq-adapter": minor
---

Add typed job results, queue default handlers, readiness and manager error events.
Public declarations now require TypeScript >=5.4 (`NoInfer`). Existing void jobs and
constructor connection arguments remain supported. Registration after startup,
conflicting queue defaults and operations during stop now reject. Producer-only
stop releases managed queues; lifecycle deadlines and cleanup failures reject
rather than reporting successful release. Borrowed Redis clients remain owned by
the caller. BullMQ support is ^5.16.0 || ^6.3.11; the adapter follows the matching
core generation through workspace:^. These lifecycle and typing changes are
breaking changes during 0.x development. Release both packages as 0.2.0 without
declaring a stable 1.0 API.

Declare ioredis ^5.0.0 as an optional adapter peer: connection options require
this driver (BullMQ 6 does not auto-install it). Borrowed-client users supply
their own compatible driver and retain client ownership. Development and isolated
consumer validation pin ioredis 5.11.1.

Direct BullMQQueueManager users must now call startWorkers() after createWorker().
Workers are created with autorun disabled; startWorkers() waits for all managed
connections before consuming. JobRuntime.start() already performs this sequence.
