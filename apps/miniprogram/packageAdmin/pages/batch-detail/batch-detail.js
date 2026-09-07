const { ensureAdmin, adminRequest } = require('../../../utils/admin');
const { fetchAll, cents, pageSlice } = require('../../list');
Page({
  data:{loading:true,error:'',rows:[],page:1,pages:1,total:0,picked:[],allPicked:false,selectedAmount:'0.00',selectedHouses:0,busy:false,isAdmin:false},
  onLoad(o){this.id=o.id;this.load();},
  async onPullDownRefresh(){try{await this.load();}finally{wx.stopPullDownRefresh();}},
  async load(){this.setData({loading:true,error:''});try{
    const a=await ensureAdmin();
    this._rows=(await fetchAll('/admin/bills?status=DRAFT&batchId='+encodeURIComponent(this.id))).map(r=>({...r,name:(r.house&&(r.house.displayName||r.house.code))||'',cents:cents(r.amount)}));
    this.setData({isAdmin:a.role==='TENANT_ADMIN'||a.role==='SUPER_ADMIN'});
    this.apply(this.data.picked.filter(id=>this._rows.some(r=>r.id===id)));
  }catch(e){this.setData({error:e.message||'加载失败，请重试'});}finally{this.setData({loading:false});}},
  apply(picked){const all=this._rows||[],set=new Set(picked),selected=all.filter(r=>set.has(r.id));
    const pages=Math.max(1,Math.ceil(all.length/20)),page=Math.min(this.data.page,pages);
    this.setData({picked,allPicked:!!all.length&&picked.length===all.length,total:all.length,pages,page,
      selectedHouses:new Set(selected.map(r=>r.houseId)).size,selectedAmount:(selected.reduce((s,r)=>s+r.cents,0)/100).toFixed(2),
      rows:pageSlice(all,page).map(r=>({...r,checked:set.has(r.id)}))});},
  toggle(e){if(this.data.busy)return;const id=e.currentTarget.dataset.id;this.apply(this.data.picked.includes(id)?this.data.picked.filter(x=>x!==id):this.data.picked.concat(id));},
  all(){if(this.data.busy)return;this.apply(this.data.allPicked?[]:this._rows.map(r=>r.id));},
  clear(){if(!this.data.busy)this.apply([]);},
  turn(e){const page=this.data.page+Number(e.currentTarget.dataset.delta);if(page<1||page>this.data.pages)return;this.setData({page});this.apply(this.data.picked);wx.pageScrollTo({scrollTop:0,duration:0});},
  async publish(){if(this.data.busy||this.data.loading||this.data.error)return;if(!this.data.picked.length)return wx.showToast({title:'请选择账单',icon:'none'});
    const ids=this.data.picked.slice().sort(),amount=this.data.selectedAmount;
    this.setData({busy:true});
    try {const ok=await new Promise(resolve=>wx.showModal({title:'发布账单',content:`已选 ${this.data.selectedHouses} 户、${ids.length} 笔，合计 ¥${amount}。未选 ${this.data.total-ids.length} 笔保留草稿。`,confirmText:'确认发布',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!ok)return;
      const signature=JSON.stringify([ids,amount]);
      if(this._signature!==signature){this._signature=signature;this._requestId='mp-selected-'+Date.now()+'-'+Math.random().toString(36).slice(2);}
      const r=await adminRequest('/admin/bill-batches/'+encodeURIComponent(this.id)+'/publish-selected',{method:'POST',data:{billIds:ids,expectedTotalAmount:amount,requestId:this._requestId}});
      this._signature='';this.apply([]);wx.showToast({title:'已发布 '+r.publishedCount+' 笔',icon:'none'});await this.load();
    }finally{this.setData({busy:false});}},
});
