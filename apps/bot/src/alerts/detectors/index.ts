import type { LogDetector, TxDetector } from "../types.js";
import { activityDetector } from "./activity.js";
import { governanceDetector } from "./governance.js";
import { moneyDetector } from "./money.js";
import { securityDetector } from "./security.js";
import { stakingDetector } from "./staking.js";
import { tokenDetector } from "./tokens.js";

/**
 * Every detector QoreWatch runs. To add an alert: write a detector in this folder,
 * add it here, and add a test in test/detectors.test.ts. Nothing else changes.
 */
export const TX_DETECTORS: TxDetector[] = [securityDetector, moneyDetector, activityDetector, stakingDetector, governanceDetector];
export const LOG_DETECTORS: LogDetector[] = [tokenDetector];
