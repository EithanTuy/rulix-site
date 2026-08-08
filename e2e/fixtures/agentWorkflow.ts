import { TestRegulatoryCorpus, createWorkflowProvider } from "../../server/test/agentWorkflowFixtures";

const workflow = createWorkflowProvider({ candidateCount: 2, candidateDelayMs: 4 });

export const agentWorkflowClient = workflow.client;
export const agentWorkflowCorpus = new TestRegulatoryCorpus();
