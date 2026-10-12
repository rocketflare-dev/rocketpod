/**
 * The `triage-research` agent (D37): one search, a `ctx.decide.sift` relevance screen, a
 * `ctx.decide` "is this answerable?" triage, then code routes — answer from the kept passages,
 * say the knowledge base does not cover it, or escalate to `research-topic`. `Decisions` scores the
 * recorded answers per question (no model call) against `expected.decisions`; the rest judge the
 * answer as `research-topic`'s suite does. Run it once with a TypeSafe key in `.dev.vars` and once
 * without to compare Jev with the chat-model fallback on the same cases.
 */
import { triageResearchOutputSchema } from '@rocketpod/shared/ai/agents'
import {
  agentHarness,
  ContainsJudge,
  DecisionJudge,
  describeCases,
  FaithfulnessJudge,
  loadDataset,
  RubricJudge,
  SchemaJudge,
  TrajectoryJudge,
} from '../../kit'

describeCases('agent · triage-research', {
  harness: agentHarness('triage-research'),
  judges: [
    TrajectoryJudge('superset'),
    SchemaJudge(triageResearchOutputSchema),
    DecisionJudge(),
    ContainsJudge(),
    FaithfulnessJudge(),
    RubricJudge(),
  ],
  cases: loadDataset('triage-research'),
})
