// Loaded only by the static Company preview. The live employee adapter is unchanged.
import {DemoEmployeeAdapter as BaseDemoAdapter} from '/employee-assets/base-demo.mjs';
import {employees as seed} from '/company/demo-adapter.mjs';
import {HiringStore,employeeFromHire,HIRING_KEY} from '/company/hiring-store.mjs';
export class DemoEmployeeAdapter extends BaseDemoAdapter {
  constructor(){
    super();this.employees=[];this.works=[];this.activity=[];this.nextId=0;
    let storage;try{storage=localStorage;}catch{}
    this.hiring=new HiringStore(storage);
    this.welcome=new URLSearchParams(location.search).get('welcome');
    for(const e of seed)this.importEmployee(e);
    for(const h of this.hiring.hires)if(h.employeeId!==this.welcome)this.importEmployee(employeeFromHire(h));
    // Preserve the established employee management demo without persisting it as company truth.
    this.onStorage=event=>{if(event.key!==HIRING_KEY)return;this.hiring.load();this.syncHires();};
    window.addEventListener('storage',this.onStorage);
  }
  importEmployee(e){
    super.add(false);const item=this.employees.at(-1);
    Object.assign(item,{id:e.id,displayName:e.name,position:e.role,positionId:e.positionId??`demo-position-${e.id}`,sprite:e.portrait,capabilities:[...e.skills],config:{instructions:e.quote,tokenLimitPerRun:40000}});
    if(['Working','Reviewing'].includes(e.state)){item.kind=e.state==='Reviewing'?1:0;this.works.push(this.openWork(item,`${e.work}（模拟）`));}
    this.log(e.id,e.source==='hiring-demo'?'Founder 已确认入职 · 本地招聘演示':'公司演示团队成员');
  }
  syncHires(){for(const hire of this.hiring.hires)if(!this.employees.some(e=>e.id===hire.employeeId))this.importEmployee(employeeFromHire(hire));this.publish();}
  model(){const model=super.model();for(const e of model.employees){const item=this.employees.find(i=>i.id===e.employeeId);e.sprite=item.sprite;e.position.id=item.positionId??e.position.id;const hire=this.hiring?.hires.find(h=>h.employeeId===e.employeeId);if(hire)e.demo.hiring=structuredClone(hire.candidate);}return model;}
  companies(){return Promise.resolve([{id:'demo',name:'FlowCredit Studio · 本地演示'}]);}
  subscribe(id,store){const unsubscribe=super.subscribe(id,store);if(this.welcome){this.welcome=null;this.arrival=setTimeout(()=>{if(!this.disposed)this.syncHires();},350);}return unsubscribe;}
  dispose(){clearTimeout(this.arrival);window.removeEventListener('storage',this.onStorage);super.dispose();}
}
