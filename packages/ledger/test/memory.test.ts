import { describe } from "vitest";
import { memoryHarness } from "./support/harness";
import { ledgerSuite } from "./support/suite";

describe("InMemoryLedger", () => {
  ledgerSuite(memoryHarness);
});
