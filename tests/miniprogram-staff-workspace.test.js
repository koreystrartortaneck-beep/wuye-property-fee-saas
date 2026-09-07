const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../apps/miniprogram');
function harness(file,mocks={}){
  let definition;const exported={exports:{}};const wx={pageScrollTo(){},showToast(){},showModal(o){o.success({confirm:true});},navigateTo(){},stopPullDownRefresh(){},hideShareMenu(){}};
  const sandbox={module:exported,exports:exported.exports,Page:d=>definition=d,Component:d=>definition=d,wx,console,setTimeout,clearTimeout,getApp:()=>({loginReady:Promise.resolve()}),require:p=>{
    if(p.includes('utils/admin')||p==='../utils/admin')return {ensureAdmin:async()=>({role:'TENANT_ADMIN'}),adminRequest:mocks.request||asyncNoop,currentAdmin:()=>({name:'物业'})};
    if(p==='../../list')return {fetchAll:mocks.fetchAll||asyncNoop,cents:v=>Math.round(Number(v)*100),pageSlice:(r,p)=>r.slice((p-1)*20,p*20)};
    return require(path.resolve(path.dirname(path.join(root,file)),p));
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox,{filename:file});
  if(!definition)return exported.exports;
  const instance={...definition,...definition.methods,data:JSON.parse(JSON.stringify(definition.data)),setData(patch,cb){for(const [k,v]of Object.entries(patch)){const parts=k.replace(/\[(\d+)\]/g,'.$1').split('.');let o=this.data;for(const x of parts.slice(0,-1))o=o[x]||(o[x]={});o[parts.at(-1)]=v;}if(cb)cb();}};
  instance.wx=wx;return instance;
}
async function asyncNoop(){return [];}
function event(key,value){return {currentTarget:{dataset:{[key]:value}}};}
test('全量读取超过一页，不把截断清单当成全部',async()=>{
  const all=Array.from({length:550},(_,i)=>({id:'h'+i})),calls=[];
  const list=harness('packageAdmin/list.js',{request:async url=>{calls.push(url);const p=Number(new URL('http://local'+url).searchParams.get('page'));return {total:550,list:all.slice((p-1)*200,p*200)};}});
  assert.equal((await list.fetchAll('/admin/houses')).length,550);assert.equal(calls.length,3);
});
test('分页重复和金额缺失均拒绝，不显示错误汇总',async()=>{
  const list=harness('packageAdmin/list.js',{request:async()=>({total:2,list:[{id:'h1'}]})});
  await assert.rejects(list.fetchAll('/admin/houses'),/数据已更新/);assert.throws(()=>list.cents(null),/金额数据异常/);
});
test('欠费84户全选覆盖所有页，取消一户及刷新保持选择',async()=>{
  const rows=Array.from({length:84},(_,i)=>({houseId:'h'+i,code:'A-'+i,unpaidCount:1,unpaidAmount:'100.00'}));
  const panel=harness('packageAdmin/components/arrears-panel/index.js',{request:async()=>({list:rows,totalAmount:'8400.00',totalHouses:84,overdueHouses:0})});
  await panel.load();panel.toggleAll();assert.equal(panel.data.picked.length,84);assert.equal(panel.data.visibleRows.length,20);
  panel.turn(event('delta',1));panel.toggleRow(event('id','h22'));assert.equal(panel.data.picked.length,83);await panel.load();assert.equal(panel.data.page,2);assert.equal(panel.data.picked.length,83);
});
test('草稿180笔全选、取消一笔，提交179笔和精确金额',async()=>{
  const rows=Array.from({length:180},(_,i)=>({id:'b'+i,houseId:'h'+i,amount:'1.01',house:{code:'G-'+i}}));let payload;
  const page=harness('packageAdmin/pages/batch-detail/batch-detail.js',{fetchAll:async()=>rows,request:async(url,o)=>{payload=o.data;return {publishedCount:o.data.billIds.length};}});page.id='batch';await page.load();page.all();page.toggle(event('id','b0'));await page.publish();
  assert.equal(payload.billIds.length,179);assert.equal(payload.expectedTotalAmount,'180.79');assert.ok(!payload.billIds.includes('b0'));
});
test('收据汇总按筛选全集，作废不计入实收，分页不改合计',async()=>{
  const rows=Array.from({length:45},(_,i)=>({orderNo:'O'+i,totalAmount:'10.01',status:i===0?'REFUNDED':'SUCCESS',channel:'WXPAY',paidAt:'2026-09-07T00:00:00Z',bill:{house:{code:'G-'+i},title:'物业费'}}));
  const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async()=>rows});await page.load();assert.equal(page.data.amount,'440.44');assert.equal(page.data.total,44);page.turn(event('delta',1));assert.equal(page.data.amount,'440.44');assert.equal(page.data.rows.length,20);
});
test('管理端与业主共用收据模板和绘图逻辑，管理端不分享页面',()=>{
  assert.match(fs.readFileSync(path.join(root,'packageAdmin/pages/receipt/receipt.wxml'),'utf8'),/include src="\.\.\/\.\.\/\.\.\/pages\/receipt\/receipt.wxml"/);
  const admin=fs.readFileSync(path.join(root,'packageAdmin/pages/receipt/receipt.js'),'utf8');assert.match(admin,/createReceiptPage/);assert.match(admin,/delete page.onShareAppMessage/);
});
test('部分发布使用独立接口，旧后端不会误发布整批',()=>{
  const js=fs.readFileSync(path.join(root,'packageAdmin/pages/batch-detail/batch-detail.js'),'utf8');
  assert.match(js,/\/publish-selected/);assert.doesNotMatch(js,/\+'\/publish'/);
});
test('正式页面不得包含原型说明和设计话术',()=>{
  function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.wxml'))assert.doesNotMatch(fs.readFileSync(f,'utf8').replace(/<!--[\s\S]*?-->/g,''),/演练|演示|原型|样张|设计说明|AI生成|第一手段|核对要点|点房间 =/);}}walk(path.join(root,'packageAdmin'));
});
