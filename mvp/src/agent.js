// mvp/src/agent.js —— 浏览器 legacy conductor 兼容适配器。
// 确定性状态机与纯规则 helper 位于 deterministic-conductor.js；本文件只翻译
// pipeline/evaluator 的历史调用形状，并保留 setPipeline() 公共 API。

import { createDeterministicConductor } from './deterministic-conductor.js';

export {
  resolveBehaviorSuggestions,
  meanTreePatternSimilarity,
  filterMutationBounds,
  harmonyScoreFromCounts,
  ruleSequencePlan,
  padDiversityBranchWeights,
  bassRootBranchWeights,
  ensurePatternMutation,
  evaluateDay,
  planFromLlm,
  masterMenuFromConfig,
} from './deterministic-conductor.js';

function legacyReviewSource(pipeline, evaluator) {
  if (pipeline && evaluator) return { kind: 'combined-v1', pipeline, evaluator };
  if (pipeline) return { kind: 'pipeline-v1', pipeline };
  if (evaluator) return { kind: 'evaluator-v1', evaluator };
  return null;
}

export function attachPipelineConductor(world, options = {}) {
  const {
    pipeline = null,
    evaluator = null,
    ...coreOptions
  } = options;
  const capturedEvaluator = evaluator;
  const core = createDeterministicConductor(world, {
    ...coreOptions,
    reviewSource: legacyReviewSource(pipeline, capturedEvaluator),
  });
  return {
    ...core,
    setPipeline(nextPipeline) {
      core.setReviewSource(legacyReviewSource(nextPipeline, capturedEvaluator));
    },
  };
}
