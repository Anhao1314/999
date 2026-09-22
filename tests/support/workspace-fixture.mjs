// Deterministic Founder Workspace fixture. No model is involved: every fact is
// created through canonical Runtime commands, so the Workspace renders exactly
// the story this file builds — an execution, a delivery, an independent review
// that PASSes, and a Work left at READY_FOR_DECISION waiting for the Founder,
// next to one employee who is genuinely working on a second Work.
//
// `command` is the Runtime command seam: tests pass `runtime.command`, a
// script can pass a kernel-backed adapter. This fixture never touches storage
// and never writes anything a Runtime command could not write.

export async function seedWorkspaceFixture(command) {
  const company = await command('createCompany', { name: '赤道航海 · 工作台夹具' });
  const builder = await command('createPosition', {
    companyId: company.id,
    title: '内容构建',
    capabilities: ['fixture.build'],
  });
  const reviewerPosition = await command('createPosition', {
    companyId: company.id,
    title: '独立评审',
    capabilities: ['fixture.review'],
  });
  const worker = await command('createEmployee', {
    companyId: company.id,
    positionId: builder.id,
    displayName: '小林',
  });
  const reviewer = await command('createEmployee', {
    companyId: company.id,
    positionId: reviewerPosition.id,
    displayName: '阿岚',
  });
  const busy = await command('createEmployee', {
    companyId: company.id,
    positionId: builder.id,
    displayName: '启明',
  });
  const resting = await command('createEmployee', {
    companyId: company.id,
    positionId: builder.id,
    displayName: '眠舟',
    enabled: false,
  });

  // Work 1: executed, delivered, independently reviewed and PASSed — the
  // decision itself is still the Founder's.
  const work = await command('createWork', {
    companyId: company.id,
    title: '发布前的定位说明',
    intent: '让发布信息能被一句话讲清楚。',
  });
  const task = await command('createTask', {
    workId: work.id,
    title: '撰写定位说明',
    intent: '一份可以直接发布的说明。',
    requiredCapabilities: ['fixture.build'],
  });
  await command('setTaskRequirements', {
    taskId: task.id,
    requiredCapabilities: ['fixture.build'],
    reviewCapabilities: ['fixture.review'],
  });
  await command('assignTask', { taskId: task.id, employeeId: worker.id, reason: 'fixture assignment' });
  const run = await command('startWorkerRun', { taskId: task.id });
  const artifact = await command('recordArtifact', {
    taskId: task.id,
    generation: run.generation,
    workerRunId: run.workerRun.id,
    kind: 'document',
    title: '定位说明 v1',
    content: 'fixture body — the workspace never renders artifact content',
  });
  const handoff = await command('requestReview', { taskId: task.id, generation: run.generation });
  await command('assignTask', {
    taskId: handoff.reviewTask.id,
    employeeId: reviewer.id,
    reason: 'fixture review',
  });
  const reviewRun = await command('startWorkerRun', { taskId: handoff.reviewTask.id });
  await command('submitReview', {
    reviewTaskId: handoff.reviewTask.id,
    generation: reviewRun.generation,
    verdict: 'PASS',
    summary: '说明与意图一致，可以交给 Founder 决定。',
    findings: [],
  });

  // Work 2: an attempt is running, so the workforce widget shows a live
  // execution next to the decision that waits for the Founder.
  const activeWork = await command('createWork', {
    companyId: company.id,
    title: '素材清单整理',
    intent: '把发布所需素材整理成清单。',
  });
  const activeTask = await command('createTask', {
    workId: activeWork.id,
    title: '整理素材清单',
    intent: '一份素材清单。',
    requiredCapabilities: ['fixture.build'],
  });
  await command('assignTask', {
    taskId: activeTask.id,
    employeeId: busy.id,
    reason: 'fixture assignment',
  });
  const activeRun = await command('startWorkerRun', { taskId: activeTask.id });

  return {
    company,
    positions: { builder, reviewer: reviewerPosition },
    employees: { worker, reviewer, busy, resting },
    work,
    task,
    artifact,
    handoff,
    activeWork,
    activeTask,
    activeRun,
  };
}

// A company that exists and has people, but no Work at all: the honest
// “no primary Work” canvas state, with nothing to fabricate.
export async function seedEmptyWorkspaceFixture(command) {
  const company = await command('createCompany', { name: '安静港湾 · 空白夹具' });
  const position = await command('createPosition', {
    companyId: company.id,
    title: '内容构建',
    capabilities: ['fixture.build'],
  });
  const employee = await command('createEmployee', {
    companyId: company.id,
    positionId: position.id,
    displayName: '小林',
  });
  return { company, position, employee };
}
