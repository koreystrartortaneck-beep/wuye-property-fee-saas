const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../apps/miniprogram');
function harness(file,mocks={}){
  let definition;const exported={exports:{}};const wx={pageScrollTo(){},showToast(){},showModal(o){o.success({confirm:true});},navigateTo(){},navigateBack(){},redirectTo(){},getWindowInfo:()=>({statusBarHeight:44}),getMenuButtonBoundingClientRect:()=>({top:48,height:32}),stopPullDownRefresh(){},hideShareMenu(){}};
  const sandbox={module:exported,exports:exported.exports,Page:d=>definition=d,Component:d=>definition=d,wx,console,setTimeout,clearTimeout,getCurrentPages:()=>mocks.pages||[{}],getApp:()=>({loginReady:Promise.resolve()}),require:p=>{
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
test('手机号通过新搜索接口查询，返回结果仍严格分渠道',async()=>{
  let url;const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async u=>{url=u;return [{orderNo:'wx',channel:'WXPAY',status:'SUCCESS',totalAmount:'10.00'},{orderNo:'off',channel:'OFFLINE',status:'SUCCESS',totalAmount:'100.00'}];}});
  page.houseId='h1';page.setData({keyword:'13900001111'});await page.load();assert.match(url,/\/admin\/payments\/receipt-search\?/);assert.match(url,/keyword=13900001111/);assert.match(url,/houseId=h1/);assert.equal(page.data.total,1);assert.equal(page.data.amount,'10.00');
});
test('旧服务不支持搜索时显示失败，不将全部订单当搜索结果',async()=>{
  const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async()=>{const e=new Error('资源不存在');e.code=40400;throw e;}});page.setData({keyword:'测试业主'});await page.load();assert.match(page.data.error,/暂不支持收据搜索/);assert.equal(page.data.rows.length,0);
});
test('收据筛选关闭不生效，确定后重算全集，清除恢复默认',async()=>{
  const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async()=>[
    {orderNo:'a',totalAmount:'1234.56',status:'SUCCESS',channel:'WXPAY',paidAt:'2026-09-07T01:00:00Z'},
    {orderNo:'b',totalAmount:'100.00',status:'SUCCESS',channel:'OFFLINE',paidAt:'2026-09-07T01:00:00Z'},
    {orderNo:'c',totalAmount:'20.00',status:'REFUNDED',channel:'OFFLINE',paidAt:'2026-09-07T01:00:00Z'}
  ]});
  await page.load();assert.equal(page.data.amountDisplay,'1,234.56');
  page.openFilters();page.setData({draftState:1});page.closeFilters();assert.equal(page.data.stateIndex,0);assert.equal(page.data.total,1);
  page.pickChannel(event('index',1));page.openFilters();assert.equal(page.data.draftState,0);page.setData({draftState:2});page.applyFilters();
  assert.equal(page.data.total,2);assert.equal(page.data.amount,'100.00');assert.equal(page.data.filterCount,1);
  page.resetFilters();assert.equal(page.data.channelIndex,1);assert.equal(page.data.total,1);assert.equal(page.data.amount,'100.00');assert.equal(page.data.filterCount,0);
});
test('默认仅真实微信成功支付，线下、模拟、关闭及退款不混入',async()=>{
  const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async()=>[
    {orderNo:'wx',channel:'WXPAY',status:'SUCCESS',totalAmount:'302.01'},
    {orderNo:'off',channel:'OFFLINE',status:'SUCCESS',totalAmount:'1000.00'},
    {orderNo:'mock',channel:'MOCK',status:'SUCCESS',totalAmount:'9000.00'},
    {orderNo:'unknown',channel:'OTHER',status:'SUCCESS',totalAmount:'7000.00'},
    {orderNo:'refund',channel:'WXPAY',status:'REFUNDED',totalAmount:'50.00'},
    {orderNo:'closed',channel:'WXPAY',status:'CLOSED',totalAmount:'30.00'},
    {orderNo:'pending',channel:'WXPAY',status:'CREATED',totalAmount:'20.00'}
  ]});
  await page.load();assert.equal(page.data.total,1);assert.equal(page.data.rows[0].orderNo,'wx');assert.equal(page.data.amount,'302.01');
  page.openFilters();page.setData({draftState:1});page.applyFilters();assert.equal(page.data.rows[0].orderNo,'refund');assert.equal(page.data.amount,'0.00');
  page.pickChannel(event('index',1));assert.equal(page.data.total,1);assert.equal(page.data.rows[0].orderNo,'off');assert.equal(page.data.amount,'1000.00');
  page.pickChannel(event('index',0));assert.equal(page.data.rows[0].orderNo,'wx');assert.equal(page.data.states[1],'已退款');
});
test('收据页自绘导航按胶囊位置留安全区，直达页面也能返回管理首页',()=>{
  const page=harness('packageAdmin/pages/receipts/receipts.js');let redirected;
  page.wx.redirectTo=o=>redirected=o.url;page.onLoad({});assert.equal(page.data.navTop,44);assert.equal(page.data.navHeight,40);assert.equal(page.data.navBottom,84);
  page.back();assert.equal(redirected,'/packageAdmin/pages/home/home');
});
test('收据分页首尾不越界，长房号与金额分别独立排版',async()=>{
  const page=harness('packageAdmin/pages/receipts/receipts.js',{fetchAll:async()=>[]});await page.load();page.turn(event('delta',-1));page.turn(event('delta',1));assert.equal(page.data.page,1);
  const wxml=fs.readFileSync(path.join(root,'packageAdmin/pages/receipts/receipts.wxml'),'utf8');
  assert.match(wxml,/class="receipt-house"/);assert.match(wxml,/class="receipt-value-row"/);assert.match(wxml,/查看收据/);assert.doesNotMatch(wxml,/<button\b/);
});
test('收据详情404不伪造凭证，显示明确失败状态并允许恢复',async()=>{
  const exported={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/receipt-page.js'),'utf8'),{module:exported,require:p=>p==='./share'?{}:p==='./datetime'?{fmtDateTimeSec:()=>''}:{},getApp:()=>({loginReady:Promise.resolve()})});
  let definition,fail=true;
  vm.runInNewContext(fs.readFileSync(path.join(root,'packageAdmin/pages/receipt/receipt.js'),'utf8'),{Page:p=>definition=p,wx:{hideShareMenu(){}},require:p=>p.includes('utils/admin')?{ensureAdmin:async()=>{},adminRequest:async()=>{if(fail){const e=new Error('资源不存在');e.code=40400;throw e;}return {receipt:{receiptNo:'TEST',totalAmount:'12.00',bills:[]}};}}:exported.exports});
  definition.setData=function(d){Object.assign(this.data,d)};definition.orderNo='TEST';await definition.load();assert.equal(definition.data.error,true);assert.equal(definition.data.r,null);assert.equal(definition.data.errorMessage,'收据暂时无法查看');
  fail=false;await definition.load();assert.equal(definition.data.error,false);assert.equal(definition.data.r.receiptNo,'TEST');assert.equal(definition.data.errorHint,'');
});
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
