import { describe } from "vitest";
import { postgresHarness } from "./support/harness";
import { ledgerSuite } from "./support/suite";

describe("PostgresLedger", () => {
  ledgerSuite(postgresHarness);
});
