// Browser-only design data. This adapter never calls the Runtime or a model.
// Replace this boundary when the Company workspace is connected to live data.
const STORAGE_KEY = 'flowcredit.company-ui.v1.drafts';
export const employees = [
  { id:'alice', name:'Alice', role:'后端工程师', portrait:3, state:'Working', quote:'Build reliable systems.', skills:['code.backend','code.edit','debug','api'], work:'OAuth Refresh Bug' },
  { id:'iris', name:'Iris', role:'质量评审员', portrait:2, state:'Reviewing', quote:'Every detail deserves a second look.', skills:['code.review','testing','quality'], work:'OAuth Refresh Bug' },
  { id:'kai', name:'Kai', role:'研究分析师', portrait:1, state:'Working', quote:'Turn questions into clarity.', skills:['research','analysis','writing'], work:'Market Analysis' },
  { id:'luna', name:'Luna', role:'产品设计师', portrait:4, state:'Available', quote:'Make the complex feel simple.', skills:['design','product','prototyping'], work:'Company Canvas Design' },
  { id:'leo', name:'Leo', role:'前端工程师', portrait:5, state:'Available', quote:'Ideas, made tangible.', skills:['code.frontend','ui','accessibility'], work:'Company Canvas Design' },
  { id:'nova', name:'Nova', role:'内容策划', portrait:6, state:'Available', quote:'A good story moves things forward.', skills:['writing','content','strategy'], work:'Launch Content Plan' },
  { id:'milo', name:'Milo', role:'数据分析师', portrait:7, state:'Available', quote:'Find the story in the numbers.', skills:['data','analysis','reporting'], work:null },
  { id:'sage', name:'Sage', role:'运营助理', portrait:8, state:'Available', quote:'Keep the company in flow.', skills:['operations','planning','organize'], work:null },
];
export const deliveries = [
  {id:'patch',title:'Patch v2',work:'OAuth Refresh Bug',status:'PASS',employee:'iris',body:'修复说明（界面示例）\n\n统一刷新凭据的错误处理，补充登录过期和并发刷新场景的测试。\n\n这是一份用于 UI 排版的示例交付物，不包含实际代码变更；页面中的测试数量也是演示数据。'},
  {id:'research',title:'Research Report',work:'Market Analysis',status:'REVIEW',employee:'kai',body:'研究报告（界面示例）\n\n目标：比较产品定位、核心用户和功能边界。\n\n建议先聚焦个人创业者的单一工作场景。后续接入真实执行器后，这里会呈现带来源的研究结果。'},
  {id:'api',title:'API Spec',work:'Export API',status:'PASS',employee:'alice',body:'接口说明（界面示例）\n\n此区域预留给接口契约、输入输出与变更说明。当前没有新增或变更任何后端 API。'},
];
const seedWorks = [
  {id:'102',title:'OAuth Refresh Bug',description:'修复登录状态刷新失效的问题，并完善单元测试。',employee:'alice',priority:'高优先级',status:'执行中'},
  {id:'103',title:'Market Analysis',description:'整理竞品研究与产品定位建议。',employee:'kai',priority:'普通优先级',status:'评审中'},
  {id:'104',title:'Company Canvas Design',description:'设计一个让工作与团队清晰可见的公司工作台。',employee:'luna',priority:'普通优先级',status:'待开始'},
  {id:'105',title:'Launch Content Plan',description:'准备第一版产品发布内容与说明。',employee:'nova',priority:'普通优先级',status:'待开始'},
];
export class DemoCompanyAdapter {
  constructor(storage) {
    this.storage=storage; this.drafts=[]; this.storageAvailable=true;
    try {
      const rows=JSON.parse(storage?.getItem(STORAGE_KEY)??'[]');
      if(Array.isArray(rows))this.drafts=rows.filter(w=>w?.source==='demo'&&typeof w.id==='string'&&typeof w.title==='string'&&typeof w.description==='string'&&employees.some(e=>e.id===w.employee)&&['高优先级','普通优先级'].includes(w.priority)).slice(0,100).map(w=>({...w,status:'本地草稿',title:w.title.slice(0,100),description:w.description.slice(0,3000)}));
    } catch {this.storageAvailable=false;}
  }
  works(){return [...this.drafts,...seedWorks];}
  createWork(input){
    const title=String(input.title??'').trim(),description=String(input.description??'').trim();
    if(!title||title.length>100)throw new Error('请填写 1–100 字的工作名称。');
    if(description.length>3000)throw new Error('工作说明最多 3000 字。');
    if(!employees.some(e=>e.id===input.employee))throw new Error('请选择一位员工。');
    if(this.drafts.length>=100)throw new Error('本地演示草稿最多 100 条。');
    const work={id:`demo-${crypto.randomUUID()}`,source:'demo',title,description,employee:input.employee,priority:input.priority==='高优先级'?'高优先级':'普通优先级',status:'本地草稿'};
    this.drafts.unshift(work);
    try{if(!this.storage)throw new Error('storage unavailable');this.storage.setItem(STORAGE_KEY,JSON.stringify(this.drafts));}catch{this.storageAvailable=false;}
    return work;
  }
}
