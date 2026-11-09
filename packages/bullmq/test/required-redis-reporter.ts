import type { Reporter, TestModule } from "vitest/node";

/** CI must not turn skips into compatibility evidence. / CI では skip を互換性の証拠にしない。 */
export default class RequiredRedisReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[], unhandledErrors: readonly unknown[]): void {
    if (process.env.REQUIRE_REDIS_TESTS !== "1") return;
    if (unhandledErrors.length > 0 || modules.length === 0) return;
    const redisFiles = modules.filter((module) =>
      /\/(backend|routing|lifecycle|options)\.test\.ts$/.test(module.moduleId),
    );
    const tests = redisFiles.flatMap((module) => [...module.children.allTests()]);
    if (
      redisFiles.length !== 4 ||
      tests.length === 0 ||
      tests.some((test) => test.result().state === "skipped" || test.result().state === "pending")
    ) {
      throw new Error("Required Redis suites must all run with zero skips");
    }
  }
}
