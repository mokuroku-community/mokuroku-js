---
"@mokurokujs/bullmq-adapter": patch
---

Raise minimum required BullMQ version from `^5.0.0` to `^5.16.0`.

`upsertJobScheduler` / `removeJobScheduler` were introduced in BullMQ 5.16.0 and are required by this adapter. The peer dependency range now reflects that constraint.
