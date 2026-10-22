/**
 * Ask the Guide (`POST /api/guide/ask`): does the in-app help search the Guide before it answers,
 * answer only from what it found, and say so when the Guide does not cover a question? Each case
 * runs over the COMMITTED pages (`guideHarness`), so a page edit can move a score.
 *
 * Judges: `Trajectory` (it called `search_guide`), `Contains` (the fact a page states),
 * `Faithfulness` (every claim supported by the passages `search_guide` returned) and `Rubric`.
 */
import {
  ContainsJudge,
  describeCases,
  FaithfulnessJudge,
  guideHarness,
  loadDataset,
  RubricJudge,
  TrajectoryJudge,
} from '../../kit'

describeCases('guide · ask', {
  harness: guideHarness(),
  judges: [TrajectoryJudge('superset'), ContainsJudge(), FaithfulnessJudge(), RubricJudge()],
  cases: loadDataset('guide-chat'),
})
