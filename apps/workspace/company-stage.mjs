// Presentation grouping for the Company Stage. Every task, edge and artifact
// comes from the read-only Live Action projection; this module creates no Work.
export function companyStageModel(action) {
  const nodes = action?.graph?.nodes ?? [];
  const edges = action?.graph?.dependencies ?? [];
  const artifacts = new Map((action?.artifacts ?? []).map((item) => [item.artifactId, item]));
  const incoming = new Map(nodes.map((task) => [task.taskId,
    edges.filter((edge) => edge.toTaskId === task.taskId)]));
  const present = (task) => ({
    ...task,
    inputs: incoming.get(task.taskId)?.length ?? 0,
    artifacts: (task.artifactIds ?? []).map((id) => artifacts.get(id) ?? { artifactId: id, title: '已交付产物' }),
  });
  const contributors = nodes.filter((task) => task.role === 'EXECUTION' && !incoming.get(task.taskId)?.length).map(present);
  const handoffs = nodes.filter((task) => task.role === 'EXECUTION' && incoming.get(task.taskId)?.length).map(present);
  const reviews = nodes.filter((task) => task.role === 'REVIEW').map(present);
  const repairs = nodes.filter((task) => task.role === 'REPAIR').map(present);
  const active = nodes.find((task) => task.workerRunState === 'RUNNING');
  const waiting = nodes.find((task) => task.barrier && !task.barrier.ready);
  const interrupted = nodes.find((task) => task.workerRunState === 'INTERRUPTED');
  let moment;
  if (active) moment = {
    kind: 'RUNNING',
    text: `${active.employeeName ?? '已指派员工'}正在处理${active.title ? `「${active.title}」` : '当前任务'}`,
    taskId: active.taskId,
  };
  else if (waiting) moment = {
    kind: 'WAITING',
    text: `${waiting.title ?? '汇总任务'}等待上游交付 · ${waiting.barrier.fulfilled}/${waiting.barrier.required} 已到达`,
    taskId: waiting.taskId,
  };
  else if (interrupted) moment = {
    kind: 'INTERRUPTED',
    text: `${interrupted.employeeName ?? '一项执行'}已中断 · ${interrupted.title ?? '当前任务'}`,
    taskId: interrupted.taskId,
  };
  else if (action?.founderBoundary?.waitingForFounder) moment = {
    kind: 'FOUNDER', text: '交付已到达，等待你的决定', taskId: null,
  };
  else moment = { kind: 'QUIET', text: '当前没有正在执行的任务', taskId: null };
  return {
    contributors, handoffs, reviews, repairs, moment,
    deliveredCount: [...artifacts.values()].length,
    founderWaiting: Boolean(action?.founderBoundary?.waitingForFounder),
    decisionRecorded: Boolean(action?.founderBoundary?.accepted),
  };
}
