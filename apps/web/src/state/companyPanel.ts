import { createCompanyPanelEnvironmentAtoms } from "@t3tools/client-runtime/state/company-panel";

import { connectionAtomRuntime } from "../connection/runtime";

export const companyPanelEnvironment = createCompanyPanelEnvironmentAtoms(connectionAtomRuntime);
