// A node:test reporter that writes one JSON document with every test that ran.
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//        --test-reporter=../dashboard/json-reporter.mjs --test-reporter-destination=results.json ...
//
// Each entry is a leaf test (suites are only used for the name): its file, its full name with
// the suite names in front ("Suite > test"), passed / failed / skipped, and how long it took.
import { basename } from "node:path";

export default async function* jsonReporter(source) {
  const tests = [];
  // Open suites per file, by nesting level, so a test's name can carry its suite's name.
  const stacks = new Map();
  for await (const event of source) {
    const { type, data } = event;
    if (type !== "test:start" && type !== "test:pass" && type !== "test:fail") continue;
    const file = data.file ? basename(data.file) : "";
    const stack = stacks.get(file) ?? [];
    stacks.set(file, stack);
    if (type === "test:start") {
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      continue;
    }
    const details = data.details ?? {};
    stack.length = data.nesting;
    if (details.type === "suite") continue;
    // A file that fails to load reports itself as one failing test named after the file.
    const name = [...stack, data.name].join(" > ");
    const status = data.skip !== undefined || data.todo !== undefined
      ? "skipped"
      : type === "test:pass" ? "passed" : "failed";
    const entry = { file, name, status, ms: Math.round(details.duration_ms ?? 0) };
    if (status === "failed" && details.error) {
      const err = details.error.cause ?? details.error;
      entry.error = String(err?.message ?? err).slice(0, 2000);
    }
    tests.push(entry);
  }
  yield JSON.stringify({ tests }, null, 1) + "\n";
}
