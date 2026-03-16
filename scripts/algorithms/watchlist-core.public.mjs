function clampRange(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

export function computeAdaptiveImpliedReturn({
  adaptiveConfig,
  model,
  leadReturn,
  closeGapReturn,
  baseImpliedReturn,
  dayGapDays,
  gapInfo,
}) {
  const adaptiveK = Number.isFinite(model?.adaptiveK) ? model.adaptiveK : 1;
  const adaptiveBias = Number.isFinite(model?.adaptiveBias) ? model.adaptiveBias : 0;
  const isTradingSession = adaptiveConfig.sessionSplit ? dayGapDays === 1 : true;
  const leadScale = isTradingSession ? (adaptiveConfig.tradingLeadScale ?? 1) : (adaptiveConfig.offLeadScale ?? 1);
  const directionalScale = leadReturn >= 0 ? (adaptiveConfig.upMoveScale ?? 1) : (adaptiveConfig.downMoveScale ?? 1);
  const adjustedLeadSignal = leadReturn * leadScale * directionalScale;
  const shockThreshold = isTradingSession
    ? (adaptiveConfig.tradingShockThreshold ?? adaptiveConfig.shockThreshold)
    : (adaptiveConfig.offShockThreshold ?? adaptiveConfig.shockThreshold);
  const shockFlag = Math.abs(adjustedLeadSignal) >= shockThreshold;
  const adaptiveReturn = adaptiveK * adjustedLeadSignal + adaptiveBias;
  const sessionBaseBlend = isTradingSession
    ? (adaptiveConfig.tradingBaseBlend ?? adaptiveConfig.normalBaseBlend)
    : (adaptiveConfig.offBaseBlend ?? adaptiveConfig.normalBaseBlend);
  const blended = shockFlag
    ? adaptiveConfig.shockBaseBlend * baseImpliedReturn + (1 - adaptiveConfig.shockBaseBlend) * adaptiveReturn
    : sessionBaseBlend * baseImpliedReturn + (1 - sessionBaseBlend) * adaptiveReturn;
  const excess = Math.max(0, Math.abs(adjustedLeadSignal) - shockThreshold);
  const shockBoost = shockFlag ? Math.sign(adjustedLeadSignal) * excess * adaptiveConfig.shockAmplify : 0;
  const gapSignalThreshold = adaptiveConfig.gapSignalThreshold ?? 0.006;
  const branchGapFlag = Boolean(adaptiveConfig.gapBranch) && (gapInfo.isGapDayHint || Math.abs(gapInfo.gapSignal) >= gapSignalThreshold);
  const gapExcess = Math.max(0, Math.abs(gapInfo.gapSignal) - gapSignalThreshold);
  const gapCorrection = branchGapFlag
    ? (adaptiveConfig.gapCoef ?? 0) * gapInfo.gapSignal + (adaptiveConfig.gapAmplify ?? 0) * Math.sign(gapInfo.gapSignal) * gapExcess
    : 0;
  const weekendSignal = leadReturn + (adaptiveConfig.weekendFxCoef ?? 0.4) * closeGapReturn;
  const weekendExcess = dayGapDays > 1 ? Math.max(0, Math.abs(weekendSignal) - (adaptiveConfig.weekendThreshold ?? 0.01)) : 0;
  const weekendCorrection = dayGapDays > 1
    ? Math.sign(weekendSignal) * weekendExcess * (adaptiveConfig.weekendAmplify ?? 0)
    : 0;
  const weekendMomentum = dayGapDays > 1
    ? (adaptiveConfig.weekendMomentumCoef ?? 0) * (Number.isFinite(model?.lastTargetReturn) ? model.lastTargetReturn : 0)
    : 0;

  return {
    impliedReturn: clampRange(blended + shockBoost + gapCorrection + weekendCorrection + weekendMomentum, adaptiveConfig.minReturn, adaptiveConfig.maxReturn),
    adaptiveUsed: true,
    adaptiveShockTriggered: shockFlag,
  };
}
