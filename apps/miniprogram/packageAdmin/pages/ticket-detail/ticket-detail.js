const { ensureAdmin, adminRequest, currentAdmin } = require('../../../utils/admin');
const { TICKET_TYPE, TICKET_STATUS, label } = require('../../../utils/labels');
const { fmtDateTimeSec } = require('../../../utils/datetime');
Page({
  data:{loading:true,error:'',ticket:null,assignee:'',reply:'',busy:false},
  onLoad(o){this.id=o.id;this.load();},
  async load(){this.setData({loading:true,error:''});try{await ensureAdmin();const t=await adminRequest('/admin/tickets/'+encodeURIComponent(this.id),{silent:true});this.setData({ticket:{...t,name:(t.house&&(t.house.displayName||t.house.code))||'',at:fmtDateTimeSec(t.createdAt),statusText:label(TICKET_STATUS,t.status),typeText:label(TICKET_TYPE,t.type)},assignee:t.assigneeName||(currentAdmin()||{}).name||'',reply:t.replyContent||''});}catch(e){this.setData({error:e.message||'加载失败，请重试'});}finally{this.setData({loading:false});}},
  input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
  async submit(){if(this.data.busy||!this.data.ticket)return;const pending=this.data.ticket.status==='PENDING';if(!pending&&this.data.ticket.status!=='PROCESSING')return;
    const value=(pending?this.data.assignee:this.data.reply).trim();if(!value)return wx.showToast({title:pending?'请填写处理人':'请填写处理结果',icon:'none'});
    this.setData({busy:true});try{await adminRequest('/admin/tickets/'+encodeURIComponent(this.id)+(pending?'/process':'/done'),{method:'POST',data:pending?{assigneeName:value}:{replyContent:value}});wx.showToast({title:pending?'已受理':'已办结'});await this.load();}finally{this.setData({busy:false});}},
  call(){const t=this.data.ticket,phone=t&&t.wxUser&&t.wxUser.phone;if(phone)wx.makePhoneCall({phoneNumber:phone,fail:()=>{}});},
  image(e){const urls=this.data.ticket.images||[];wx.previewImage({current:e.currentTarget.dataset.url,urls});},
});
