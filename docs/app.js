'use strict';
// GitHub Pages serves only this interface; the actual GPU engine runs in local mode.
const PUBLIC_DEMO = !['127.0.0.1','localhost'].includes(location.hostname);
const $ = id => document.getElementById(id);
const store = {imageId:null, imageName:'', selected:null, lastJobId:null, viewingHistory:false, busy:false, settings:null, toastTimeout:null, previewUrl:null};
const presets = {
  economy:{ss_steps:8,slat_steps:8,texture_size:512},
  balanced:{ss_steps:12,slat_steps:12,texture_size:1024},
  quality:{ss_steps:20,slat_steps:20,texture_size:2048}
};
function toast(message, error=false){
  const node=$('toast');node.textContent=message;node.classList.toggle('error',error);node.classList.remove('hidden');
  clearTimeout(store.toastTimeout);store.toastTimeout=setTimeout(()=>node.classList.add('hidden'),5000);
}
async function api(route,options={}){
  const response=await fetch('/api/'+route,{cache:'no-store',...options});
  let result;try{result=await response.json()}catch(e){throw new Error('Нет ответа от приложения')}
  if(!response.ok)throw new Error(result.error||'Ошибка запроса');
  return result;
}
const jsonPost=(route,body)=>api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const fmtTime=(seconds)=>{
  if(seconds==null||!Number.isFinite(Number(seconds)))return '—';
  const time=Math.max(0,Math.floor(Number(seconds)));
  return String(Math.floor(time/60)).padStart(2,'0')+':'+String(time%60).padStart(2,'0');
};
const fmtEta=(seconds)=>seconds==null?'—':seconds<60?'< 1 мин':'~'+Math.ceil(seconds/60)+' мин';
function toggleDrawer(id,buttonId){
  const panel=$(id),wasHidden=panel.classList.contains('hidden');
  for(const p of ['advanced-settings','history-panel','settings-panel'])$(p).classList.add('hidden');
  for(const b of ['advanced-toggle','history-toggle'])$(b).setAttribute('aria-expanded','false');
  if(wasHidden){panel.classList.remove('hidden');if(buttonId)$(buttonId).setAttribute('aria-expanded','true')}
  if(id==='history-panel'&&wasHidden)refreshHistory();
}
$('settings-btn').addEventListener('click',()=>{if(!PUBLIC_DEMO)toggleDrawer('settings-panel')});
$('advanced-toggle').addEventListener('click',()=>toggleDrawer('advanced-settings','advanced-toggle'));
$('history-toggle').addEventListener('click',()=>toggleDrawer('history-panel','history-toggle'));
$('logs-toggle').addEventListener('click',()=>$('logs').classList.toggle('hidden'));
function fields(){
  return {
    ss_steps:Number($('ss_steps').value),slat_steps:Number($('slat_steps').value),
    ss_guidance:Number($('ss_guidance').value),slat_guidance:Number($('slat_guidance').value),
    seed:Number($('seed').value||0),random_seed:$('random_seed').checked,
    texture_size:Number($('texture_size').value),simplify:Number($('simplify').value),
    export_glb:$('export_glb').checked,export_ply:$('export_ply').checked
  };
}
function fillFields(settings){
  for(const id of ['ss_steps','slat_steps','ss_guidance','slat_guidance','seed','texture_size','simplify'])if(settings[id]!=null)$(id).value=settings[id];
  for(const id of ['random_seed','export_glb','export_ply'])if(settings[id]!=null)$(id).checked=settings[id];
  for(const id of ['trellis_path','output_path'])if(settings[id]!=null)$(id).value=settings[id];
  $('seed').disabled=$('random_seed').checked;
  const preset=Object.keys(presets).find(key=>presets[key].ss_steps===Number($('ss_steps').value)&&presets[key].slat_steps===Number($('slat_steps').value));
  if(preset)document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('active',b.dataset.preset===preset));
}
$('random_seed').addEventListener('change',()=>$('seed').disabled=$('random_seed').checked);
for(const button of document.querySelectorAll('[data-preset]'))button.addEventListener('click',()=>{
  for(const b of document.querySelectorAll('[data-preset]'))b.classList.toggle('active',b===button);
  for(const [key,value] of Object.entries(presets[button.dataset.preset]))$(key).value=value;
});
function switchToImage(){
  $('result-media').classList.add('hidden');
  $('preview-video').pause();
  $('loaded-upload').classList.remove('hidden');
  $('empty-upload').classList.add('hidden');
}
async function upload(file){
  if(!file)return;
  if(store.busy){toast('Дождись окончания генерации или останови её',true);return}
  if(!/\.(png|jpe?g|webp)$/i.test(file.name)){toast('Поддерживаются PNG, JPG и WEBP',true);return}
  if(file.size>24*1024*1024){toast('Максимальный размер — 24 МБ',true);return}
  try{
    if(PUBLIC_DEMO){
      store.imageId=null;store.imageName=file.name;store.lastJobId=null;
      if(store.previewUrl) URL.revokeObjectURL(store.previewUrl);
      store.previewUrl=URL.createObjectURL(file);$('uploaded-image').src=store.previewUrl;
      $('image-name').textContent=file.name;switchToImage();
      $('visual-status').textContent='✦ Изображение выбрано';
      $('result-state').textContent='Для генерации запусти локальную студию';
      $('public-help').classList.remove('hidden');
      toast('Фото выбрано. Генерация доступна после запуска локального TRELLIS.');
      return;
    }
    const data=await api('upload',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});
    store.imageId=data.image_id;store.imageName=file.name;store.selected='new-image';store.lastJobId=null;store.viewingHistory=false;
    if(store.previewUrl)URL.revokeObjectURL(store.previewUrl);
    store.previewUrl=URL.createObjectURL(file);$('uploaded-image').src=store.previewUrl;
    $('image-name').textContent=file.name;
    $('visual-status').textContent='✦ Готово к генерации';$('visual-status').classList.remove('busy');
    switchToImage();$('downloads-area').classList.add('hidden');$('progress-card').classList.add('hidden');
    $('result-state').innerHTML='<i class="status-dot"></i> Изображение загружено';
    $('seed-display').textContent='FP16';
  }catch(error){toast(error.message,true)}
}
const fileInput=$('image-input');
fileInput.addEventListener('change',e=>{upload(e.target.files[0]);fileInput.value=''});
$('dropzone').addEventListener('click',e=>{
  if(store.busy||e.target.closest('button,video,model-viewer,.result-tabs'))return;
  if($('result-media').classList.contains('hidden'))fileInput.click();
});
$('dropzone').addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&!store.busy){e.preventDefault();fileInput.click()}
});
$('replace-image').addEventListener('click',e=>{e.stopPropagation();fileInput.click()});
$('new-image').addEventListener('click',()=>fileInput.click());
$('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('dragover')});
$('dropzone').addEventListener('dragleave',()=>$('dropzone').classList.remove('dragover'));
$('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('dragover');upload(e.dataTransfer.files[0])});
$('generate-btn').addEventListener('click',async()=>{
  if(PUBLIC_DEMO){$('public-help').classList.remove('hidden');$('public-help').scrollIntoView({behavior:'smooth',block:'nearest'});toast('Для 3D-генерации запусти start-local.bat на компьютере.',true);return}
  if(store.busy)return;
  if(!store.imageId){fileInput.click();toast('Сначала выбери изображение');return}
  if(!$('export_glb').checked&&!$('export_ply').checked){toast('Выбери GLB или PLY в параметрах',true);toggleDrawer('advanced-settings','advanced-toggle');return}
  try{
    const started=await jsonPost('start',{image_id:store.imageId,settings:fields()});
    store.selected=null;store.lastJobId=started.id;store.busy=true;store.viewingHistory=false;
    switchToImage();
    $('downloads-area').classList.add('hidden');$('progress-card').classList.remove('hidden');
    $('visual-status').textContent='◉ Обрабатываем изображение';$('visual-status').classList.add('busy');
    $('logs').textContent='';await refreshStatus();
  }catch(error){toast(error.message,true);if(error.message.includes('Не найден TRELLIS'))toggleDrawer('settings-panel')}
});
$('cancel-btn').addEventListener('click',async()=>{
  if(!confirm('Остановить текущую генерацию?'))return;
  try{await jsonPost('cancel',{});toast('Останавливаем TRELLIS')}catch(e){toast(e.message,true)}
});
$('save-settings').addEventListener('click',async()=>{
  try{store.settings=await jsonPost('settings',{trellis_path:$('trellis_path').value,output_path:$('output_path').value});toast('Пути сохранены');$('settings-panel').classList.add('hidden')}
  catch(e){toast(e.message,true)}
});
for(const btn of document.querySelectorAll('.browse'))btn.addEventListener('click',async()=>{
  try{
    if(window.pywebview?.api?.pick_folder){const path=await window.pywebview.api.pick_folder();if(path)$(btn.dataset.target).value=path}
    else toast('В браузере вставь путь к папке вручную');
  }catch(e){toast('Введите путь вручную',true)}
});
let viewerPromise;
function importViewer(url){return new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.type='module';script.src=url;
  const timeout=setTimeout(()=>reject(new Error('Долгая загрузка 3D-компонента')),9000);
  script.onload=()=>{clearTimeout(timeout);customElements.whenDefined('model-viewer').then(resolve,reject)};
  script.onerror=()=>{clearTimeout(timeout);script.remove();reject(new Error('3D-компонент недоступен'))};
  document.head.appendChild(script);
})}
async function ensureViewer(){
  if(customElements.get('model-viewer'))return;
  if(!viewerPromise)viewerPromise=importViewer('/model-viewer.min.js').catch(()=>importViewer('https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js'));
  return viewerPromise;
}
function showVideo(){
  $('model-view').classList.add('hidden');$('preview-video').classList.remove('hidden');
  $('show-video').classList.add('active');$('show-3d').classList.remove('active');
  $('preview-video').play().catch(()=>{});
}
$('show-video').addEventListener('click',showVideo);
$('show-3d').addEventListener('click',async()=>{
  try{await ensureViewer()}catch(e){toast('3D-плеер недоступен; видео 360° работает без него.',true);return}
  $('preview-video').pause();$('preview-video').classList.add('hidden');
  $('model-view').classList.remove('hidden');$('show-video').classList.remove('active');$('show-3d').classList.add('active');
});
function showPreview(job){
  if(job.status!=='done')return;
  const files=job.files||{},id=encodeURIComponent(job.id);
  if(!files.preview&&!files.glb)return;
  $('empty-upload').classList.add('hidden');$('loaded-upload').classList.add('hidden');$('result-media').classList.remove('hidden');
  $('seed-display').textContent='SEED '+(job.seed??'—');
  const vid=$('preview-video'),viewer=$('model-view');
  vid.classList.toggle('hidden',!files.preview);
  $('show-video').classList.toggle('hidden',!files.preview);
  $('show-3d').classList.toggle('hidden',!files.glb);
  if(files.preview){vid.src=`/files/${id}/preview.mp4`;vid.load()}
  if(files.glb)viewer.setAttribute('src',`/files/${id}/model.glb`);
  if(files.preview)showVideo();else $('show-3d').click();
  $('downloads-area').classList.remove('hidden');
  $('duration-text').textContent='Заняло '+fmtTime(job.elapsed_sec);
  $('downloads-list').replaceChildren();
  for(const [kind,label] of [['glb','Скачать GLB'],['ply','Скачать PLY']])if(files[kind]){
    const a=document.createElement('a');a.href=`/files/${id}/model.${kind}`;a.download=`model.${kind}`;a.textContent=label+' ↗';$('downloads-list').append(a);
  }
  $('open-folder').classList.remove('hidden');$('open-folder').dataset.id=job.id;
}
$('open-folder').addEventListener('click',async()=>{
  try{await jsonPost('open-folder',{id:$('open-folder').dataset.id})}catch(e){toast(e.message,true)}
});
function updateStatus(job){
  if(!job)return;
  // Do not replace a freshly selected image with a preview from an older job.
  if(store.viewingHistory&&!store.busy)return;
  if(store.imageId&&!store.lastJobId&&job.status!=='running')return;
  store.busy=job.status==='running';
  $('generate-btn').disabled=store.busy;$('generate-label').textContent=store.busy?'Генерация в процессе…':'Создать 3D-модель';
  $('cancel-btn').classList.toggle('hidden',!store.busy);
  const labels={running:'Генерация',done:'Готово',error:'Ошибка',cancelled:'Остановлено'};
  $('result-state').textContent=labels[job.status]||'Ожидание';
  $('progress-card').classList.toggle('hidden',!store.busy&&job.status!=='error'&&job.status!=='cancelled');
  $('progress-title').textContent=job.status==='running'?job.message:(labels[job.status]||'Ожидание');
  $('progress-desc').textContent=job.message||'TRELLIS обрабатывает изображение';
  $('stage-counter').textContent=(job.stage_number||0)+' / 4';
  $('elapsed').textContent=fmtTime(job.elapsed_sec);$('eta').textContent=fmtEta(job.eta_sec);
  $('elapsed-compact').textContent=fmtTime(job.elapsed_sec);$('eta-compact').textContent=fmtEta(job.eta_sec);
  // The track indicates a coarse processing stage, NOT measured diffusion percent.
  const stageSegments={loading:10,preparing:26,generating:50,exporting:84,complete:100};
  $('progress-fill').style.width=(job.status==='done'?100:stageSegments[job.stage]||0)+'%';
  $('logs').textContent=(job.logs||[]).join('\n')+(job.error?'\n\nОШИБКА:\n'+job.error:'');
  $('logs').scrollTop=$('logs').scrollHeight;
  if(store.busy){$('visual-status').textContent='◉ '+(job.message||'Генерация 3D');$('visual-status').classList.add('busy')}
  else {$('visual-status').textContent='✦ Готово к генерации';$('visual-status').classList.remove('busy')}
  if(job.status==='done'&&store.selected!==job.id){store.selected=job.id;showPreview(job)}
  if(job.status==='error'&&store.selected!==job.id){store.selected=job.id;toast('Ошибка TRELLIS — открой журнал ошибок',true)}
}
async function refreshStatus(){try{const job=await api('status');if(job)updateStatus(job)}catch(e){/* server may be restarting */}}
async function refreshHistory(){
  if(PUBLIC_DEMO){$('history-items').innerHTML='<p class="field-hint">История появится после запуска локальной студии.</p>';return}
  try{
    const jobs=await api('history'),panel=$('history-items');panel.replaceChildren();
    if(!jobs.length){const p=document.createElement('p');p.className='field-hint';p.textContent='Пока нет результатов.';panel.appendChild(p);return}
    for(const job of jobs.slice(0,12)){
      const row=document.createElement('div');row.className='history-entry';
      const image=document.createElement('img');image.src=`/files/${encodeURIComponent(job.id)}/input.png`;image.alt='';row.append(image);
      const info=document.createElement('div'),title=document.createElement('strong'),subtitle=document.createElement('small');
      title.textContent=job.id;subtitle.textContent=(job.status==='done'?'Готово':job.status==='error'?'Ошибка':'Остановлено')+' · '+fmtTime((job.finished_at||job.started_at)-job.started_at);
      info.append(title,subtitle);
      const actions=document.createElement('div');actions.className='history-actions';
      for(const ext of ['glb','ply'])if(job.files?.[ext]){
        const a=document.createElement('a');a.textContent=ext.toUpperCase();a.href=`/files/${encodeURIComponent(job.id)}/model.${ext}`;a.download=`model.${ext}`;actions.append(a);
      }
      if(job.status==='done'){
        const view=document.createElement('a');view.href='#';view.textContent='Просмотр';view.addEventListener('click',e=>{e.preventDefault();store.selected=job.id;store.viewingHistory=true;showPreview(job);$('history-panel').classList.add('hidden')});actions.append(view);
      }
      info.append(actions);row.append(info);panel.append(row);
    }
  }catch(e){toast(e.message,true)}
}
for (const id of ['right-open-btn','right-chevron'])$(id).addEventListener('click',()=>{
  if(PUBLIC_DEMO){$('public-help').classList.remove('hidden');$('public-help').scrollIntoView({behavior:'smooth',block:'nearest'});return}
  toggleDrawer('history-panel','history-toggle');
  $('history-panel').scrollIntoView({behavior:'smooth',block:'nearest'});
});
if(PUBLIC_DEMO){
  $('connection-pill').innerHTML='<i></i>Демо';
  $('connection-pill').classList.add('demo');
  $('public-help').classList.remove('hidden');
  $('settings-btn').addEventListener('click',()=>{$('public-help').classList.remove('hidden')});
  $('result-state').textContent='Интерфейс · локальная генерация';
}else{
  (async()=>{
    try{store.settings=await api('settings');fillFields(store.settings);await refreshStatus()}catch(e){toast(e.message,true)}
    setInterval(refreshStatus,1100);
  })();
}
