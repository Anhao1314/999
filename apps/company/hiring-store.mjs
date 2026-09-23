// Prototype-only hiring state. No Runtime calls, company truth or real authority.
export const HIRING_KEY = 'flowcredit.company-ui.hiring.v1';
export const templates = [
  {id:'engineer',title:'Software Engineer',label:'软件工程师',mission:'负责后端实现、问题排查与可靠交付，让每一次变更都有测试依据。',capabilities:['backend.node','api.design','debugging','testing'],review:['code.review','testing'],skills:['TDD Fix','API Debugging','Repository Analysis']},
  {id:'research',title:'Research Analyst',label:'研究分析师',mission:'从可信来源研究问题，区分事实与推断，交付有证据的分析建议。',capabilities:['research','analysis','writing'],review:['source.review'],skills:['Source Verification','Research Brief']},
  {id:'reviewer',title:'Reviewer',label:'质量评审员',mission:'独立检查交付物是否满足目标，提供可执行的修订意见。',capabilities:['code.review','testing','quality'],review:['code.review'],skills:['TDD Fix','Repository Analysis']},
  {id:'growth',title:'Growth Specialist',label:'增长分析师',mission:'研究用户需求与增长机会，以小规模实验验证方向。',capabilities:['growth.analysis','research','experiments'],review:['source.review'],skills:['Research Brief','Experiment Design']},
  {id:'support',title:'Customer Support',label:'客户支持',mission:'理解客户问题，整理解决方案，需要授权时及时升级。',capabilities:['support','writing','triage'],review:['quality'],skills:['Issue Triage','Source Verification']},
  {id:'content',title:'Content Operator',label:'内容运营',mission:'围绕产品目标整理内容，检查表述准确性，并提交发布草稿。',capabilities:['content','writing','research'],review:['source.review'],skills:['Research Brief','Content Review']},
];
export const capabilityCatalog = ['backend.node','api.design','debugging','testing','code.review','security.review','infrastructure','payments.integration','research','analysis','writing','quality','growth.analysis','experiments','support','triage','content','source.review'];
export const skillCatalog = ['TDD Fix','API Debugging','Repository Analysis','Source Verification','Research Brief','Experiment Design','Issue Triage','Content Review'];
export const knowledgeCatalog = ['Engineering Knowledge','Product Docs','Finance','Customer Data'];
export const toolCatalog = ['Local Repository','Terminal','Git','GitHub','Shopify','Gmail'];
export const permissionCatalog = ['Read','Draft','Modify workspace'];
const cleanText=(value,max=100)=>String(value??'').trim().slice(0,max);
const strings=(value,max=24)=>Array.isArray(value)?[...new Set(value.filter(v=>typeof v==='string').map(v=>cleanText(v,80)).filter(Boolean))].slice(0,max):[];
export function newCandidate(templateId='engineer',need='') {
  const t=templates.find(t=>t.id===templateId)??templates[0];
  return {id:`candidate-${crypto.randomUUID()}`,positionId:`prototype-position-${crypto.randomUUID()}`,source:'prototype',step:1,templateId:t.id,position:t.title,mission:t.mission,capabilities:[...new Set([...t.capabilities,...(need?[need]:[])])],review:[...t.review],skills:[...t.skills],name:'',portrait:3,communication:'简洁清晰',workingStyle:'先验证，再交付',about:'',knowledge:['Engineering Knowledge','Product Docs'],tools:['Local Repository','Terminal','Git'],permissions:['Read','Draft'],trialTitle:({engineer:'修复一个小型 API 输入校验问题',research:'整理一份三家竞品的研究简报',reviewer:'评审一份补丁并提出修订建议',growth:'设计一个可衡量的增长实验',support:'为一条客户问题整理回复草稿',content:'撰写一份产品更新内容草稿'})[t.id],criteria:t.id==='engineer'?'行为符合要求\n测试通过\n受保护路径未改变':'符合岗位使命\n结论可验证，来源清楚\n未超出访问范围与权限',reviewer:'iris',trial:null,confirmed:false};
}
export function normalizeCandidate(input) {
  if(!input||input.source!=='prototype'||!/^candidate-[\w-]+$/.test(input.id??''))return null;
  const base=newCandidate(input.templateId);
  const candidate={...base,id:input.id,positionId:/^prototype-position-[\w-]+$/.test(input.positionId??'')?input.positionId:base.positionId,step:Math.max(1,Math.min(6,Math.floor(Number(input.step))||1)),position:cleanText(input.position),mission:cleanText(input.mission,1500),capabilities:strings(input.capabilities),review:strings(input.review),skills:strings(input.skills).filter(s=>skillCatalog.includes(s)),name:cleanText(input.name,40),portrait:Number.isInteger(input.portrait)&&input.portrait>=1&&input.portrait<=8?input.portrait:3,communication:cleanText(input.communication),workingStyle:cleanText(input.workingStyle),about:cleanText(input.about,500),knowledge:strings(input.knowledge).filter(s=>knowledgeCatalog.includes(s)),tools:strings(input.tools).filter(s=>toolCatalog.includes(s)),permissions:strings(input.permissions).filter(s=>permissionCatalog.includes(s)),trialTitle:cleanText(input.trialTitle,160),criteria:cleanText(input.criteria,1500),reviewer:cleanText(input.reviewer),trial:null,confirmed:false};
  const trial=input.trial;
  if(trial?.source==='demo'&&['PASS','REQUEST_REVISION'].includes(trial.verdict)&&trial.fingerprint===candidateFingerprint(candidate))candidate.trial={source:'demo',verdict:trial.verdict,fingerprint:trial.fingerprint,at:cleanText(trial.at),artifact:'Trial Artifact v1 · 模拟'};
  return candidate;
}
export function candidateFingerprint(c) {
  const keys=['position','mission','capabilities','review','skills','name','portrait','communication','workingStyle','about','knowledge','tools','permissions','trialTitle','criteria','reviewer'];
  return JSON.stringify(keys.map(key=>c[key]));
}
export function validateStep(candidate,step) {
  if(step===1&&(!candidate.position.trim()||!candidate.mission.trim()||!candidate.capabilities.length))return '请填写岗位、使命，并至少声明一项能力。';
  if(step===2&&!candidate.name.trim())return '为这位员工起一个名字，再继续。';
  if(step===3&&!candidate.capabilities.length)return '至少保留一项岗位能力。';
  if(step===5&&(!candidate.trialTitle.trim()||!candidate.criteria.trim()||!candidate.reviewer))return '请填写试用工作、成功标准并选择独立评审员。';
  return '';
}
export function trialIsCurrent(c){return c.trial?.source==='demo'&&c.trial.verdict==='PASS'&&c.trial.fingerprint===candidateFingerprint(c);}
export function employeeFromHire(hire){const c=hire.candidate;return {id:hire.employeeId,name:c.name,role:c.position,portrait:c.portrait,state:'Available',quote:c.about||c.mission,skills:[...c.capabilities],work:null,source:'hiring-demo',positionId:c.positionId};}
export class HiringStore {
  constructor(storage){this.storage=storage;this.drafts=[];this.hires=[];this.persistent=Boolean(storage);this.load();}
  load(){
    try{
      const data=JSON.parse(this.storage?.getItem(HIRING_KEY)??'{}');
      const ids=new Set();
      this.hires=(Array.isArray(data.hires)?data.hires:[]).flatMap(h=>{
        const candidate=normalizeCandidate(h?.candidate);
        if(!candidate||h.source!=='demo'||h.confirmed!==true||!trialIsCurrent(candidate)||h.employeeId!==`hire-${candidate.id}`||ids.has(candidate.id))return [];
        ids.add(candidate.id);return [{source:'demo',confirmed:true,employeeId:h.employeeId,candidate,at:cleanText(h.at)}];
      }).slice(0,100);
      this.drafts=(Array.isArray(data.drafts)?data.drafts:[]).flatMap(d=>{const c=normalizeCandidate(d);if(!c||ids.has(c.id))return [];ids.add(c.id);return [c];}).slice(0,20);
    }catch{this.drafts=[];this.hires=[];this.persistent=false;}
  }
  persist(){try{if(!this.storage)throw new Error('Unavailable');this.storage.setItem(HIRING_KEY,JSON.stringify({version:1,drafts:this.drafts,hires:this.hires}));this.persistent=true;}catch{this.persistent=false;}}
  save(candidate){const c=normalizeCandidate(candidate);if(!c)throw new Error('无效的招聘草稿。');if(this.hires.some(h=>h.candidate.id===c.id))throw new Error('这位员工已经在演示团队中。');const i=this.drafts.findIndex(d=>d.id===c.id);if(i<0){if(this.drafts.length>=20)throw new Error('最多保留 20 个本地岗位草稿。');this.drafts.unshift(c);}else this.drafts[i]=c;this.persist();return c;}
  discard(id){this.drafts=this.drafts.filter(c=>c.id!==id);this.persist();}
  confirm(candidate,founderConfirmed=false){
    const existing=this.hires.find(h=>h.candidate.id===candidate.id);if(existing)return existing;
    const c=normalizeCandidate(candidate);if(!c)throw new Error('无效的候选员工。');
    for(const step of [1,2,3,5]){const error=validateStep(c,step);if(error)throw new Error(error);}
    if(!trialIsCurrent(c))throw new Error('当前配置尚未通过模拟试用，请先完成试用。');
    if(!founderConfirmed)throw new Error('请由 Founder 确认岗位与权限边界。');
    if(this.hires.length>=100)throw new Error('本地演示团队最多新增 100 位员工。');
    const hire={source:'demo',confirmed:true,employeeId:`hire-${c.id}`,candidate:c,at:new Date().toISOString()};
    this.hires.push(hire);this.drafts=this.drafts.filter(d=>d.id!==c.id);this.persist();return hire;
  }
}
