// Read-only presentation seam. Runtime owns every hiring transition.
export const HIRING_CONTRACT = 'CompanyHiringRead.v0';
const unavailable = reason => ({ state: 'unavailable', items: [], reason });
const kinds = ['demand', 'openings', 'candidates', 'history'];
const string = value => typeof value === 'string' ? value.trim() : '';

export function readCompanyHiring(projection, companyId) {
  const raw = projection?.hiring;
  if (!raw) return Object.fromEntries(kinds.map(key => [key, unavailable('NOT_CONNECTED')]));
  if (raw.contract !== HIRING_CONTRACT || !companyId || raw.companyId !== companyId)
    return Object.fromEntries(kinds.map(key => [key, unavailable('INVALID_CONTRACT')]));
  return Object.fromEntries(kinds.map(key => {
    const collection = raw[key];
    if (collection?.state !== 'ready' || !Array.isArray(collection.items))
      return [key, unavailable(collection?.state === 'error' ? 'READ_ERROR' : 'NOT_CONNECTED')];
    const seen = new Set();
    const valid = collection.items.every(item => {
      if (!string(item?.id) || item.companyId !== companyId || seen.has(item.id)) return false;
      seen.add(item.id);
      if (key === 'demand') return Boolean(string(item.capability) && string(item.reason));
      if (key === 'openings') return Boolean(string(item.positionId) && string(item.status));
      if (key === 'candidates') return Boolean(string(item.displayName) && string(item.positionId)
        && (!item.trial || string(item.trial.workId))
        && (!item.founderDecision || string(item.founderDecision.disposition)));
      return Boolean(string(item.title) && string(item.outcome));
    });
    return [key, valid ? { state: 'ready', items: collection.items, reason: null } : unavailable('INVALID_CONTRACT')];
  }));
}

export function positionRoster(positions, employees, companyId) {
  if (!Array.isArray(positions)) return null;
  const people = Array.isArray(employees) ? employees.filter(e => e?.companyId === companyId) : null;
  const seen = new Set();
  return positions.filter(p => p?.companyId === companyId && string(p.id) && string(p.title) && !seen.has(p.id) && seen.add(p.id))
    .map(position => ({ position, employees: people?.filter(e => e.positionId === position.id) ?? null }));
}

export function candidatePhase(candidate) {
  if (candidate?.founderDecision?.disposition === 'HIRE' && string(candidate.employeeId)) return 'HIRED';
  if (candidate?.founderDecision) return 'DECIDED';
  if (candidate?.decisionRequired === true && candidate?.trial?.review?.verdict === 'PASS') return 'NEEDS_YOU';
  if (candidate?.trial?.workId && ['ASSIGNED', 'RUNNING', 'REVIEWING'].includes(candidate.trial.state)) return 'IN_TRIAL';
  if (candidate?.trial?.review) return 'EVIDENCE_RECORDED';
  if (candidate?.trial?.workId) return 'TRIAL_LINKED';
  return 'CANDIDATE';
}

export function capabilityText(capability) {
  const labels = {
    'research.interviews': '用户访谈', 'research.synthesis': '研究归纳',
    'product.strategy': '产品策略', 'product.writing': '产品写作',
    'design.prototype': '原型设计', 'design.visual': '视觉设计',
    'founder.assistant': '创始人协作',
    'commerce.product.research': '产品研究', 'commerce.user.insights': '用户洞察',
    'commerce.market.analysis': '市场分析', 'commerce.market.review': '独立复核',
    'commerce.market.synthesis': '市场进入方案',
  };
  if (typeof capability === 'string') return labels[capability] || capability;
  return string(capability?.title) || labels[capability?.id] || string(capability?.id) || '未命名能力';
}
