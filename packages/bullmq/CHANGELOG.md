# @mokurokujs/bullmq-adapter

## 0.2.0

### Minor Changes

- [#32](https://github.com/mokuroku-community/mokuroku-js/pull/32) [`4d8b373`](https://github.com/mokuroku-community/mokuroku-js/commit/4d8b373be955c4d9c550eb5ed78e19930f25d81b) Thanks [@samunohito](https://github.com/samunohito)! - Add typed job results, queue default handlers, readiness and manager error events.
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

### Patch Changes

- Updated dependencies [[`4d8b373`](https://github.com/mokuroku-community/mokuroku-js/commit/4d8b373be955c4d9c550eb5ed78e19930f25d81b)]:
  - @mokurokujs/core@0.2.0

## 0.1.0

### Minor Changes

- [#25](https://github.com/mokuroku-community/mokuroku-js/pull/25) [`da38e51`](https://github.com/mokuroku-community/mokuroku-js/commit/da38e5165aab91f4e693bd8b991a7f2dad8ff16e) Thanks [@samunohito](https://github.com/samunohito)! - Add `jobId` to enqueue options and forward it to BullMQ for native job deduplication.

### Patch Changes

- Updated dependencies [[`da38e51`](https://github.com/mokuroku-community/mokuroku-js/commit/da38e5165aab91f4e693bd8b991a7f2dad8ff16e)]:
  - @mokurokujs/core@0.1.0

## 0.0.4

### Patch Changes

- [#18](https://github.com/mokuroku-community/mokuroku-js/pull/18) [`170b498`](https://github.com/mokuroku-community/mokuroku-js/commit/170b498e8c30d0e3a9a90fc2706a2dbb08f22029) Thanks [@renovate](https://github.com/apps/renovate)! - Raise minimum required BullMQ version from `^5.0.0` to `^5.16.0`.

  `upsertJobScheduler` / `removeJobScheduler` were introduced in BullMQ 5.16.0 and are required by this adapter. The peer dependency range now reflects that constraint.

## 0.0.3

### Patch Changes

- [#8](https://github.com/mokuroku-community/mokuroku-js/pull/8) [`a0c560b`](https://github.com/mokuroku-community/mokuroku-js/commit/a0c560b125c62be889f594cd5349219eb8829da0) Thanks [@samunohito](https://github.com/samunohito)! - fix completed log level

## 0.0.2

### Patch Changes

- [#6](https://github.com/mokuroku-community/mokuroku-js/pull/6) [`fe4e9bc`](https://github.com/mokuroku-community/mokuroku-js/commit/fe4e9bc9b304a463ac0da6f3b0e97665ae193957) Thanks [@samunohito](https://github.com/samunohito)! - adjust bullmq-adapter dependencies version
