'use strict';
// Static GitHub Pages provides the design. Only the local Python service runs TRELLIS.
const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '7867';
const STAGES = ['loading', 'preparing', 'generating', 'exporting'];
const STAGE_NAMES = {loading:'Загрузка нейросети', preparing:'Подготовка изображения', generating:'Собираем геометрию', exporting:'Экспорт модели'};
const STAGE_HINTS = {loading:'Загружаем модель TRELLIS в память',preparing:'Подготавливаем фото для генерации',generating:'Создание 3D — длительность зависит от вашего GPU',exporting:'Сохраняем файлы GLB / PLY'};
const PRESETS = {
  economy:{ss_steps:8,slat_steps:8,texture_size:512},
  balanced:{ss_steps:12,slat_steps:12,texture_size:1024},
  quality:{ss_steps:20,slat_steps:20,texture_size:2048}
};
const state = {local:LOCAL,view:'studio',imageFile:null,imageId:null,imageURL:null,job:null,history:[],historyMode:false,settingSnapshot:null,notifyOnFinish:false,selectedPreset:'economy',waitingToStart:false,lastJobStatus:null,toastTimer:0,viewerReady:false,view3d:false};

const FORMAT = {glb:['model.glb','Готов к использованию'],ply:['model.ply','Без текстуры, для скульптинга'],preview:['preview.mp4','Видео 360°']};
const filesize = n => n<1024*1024 ? (n/1024).toFixed(0)+' КБ' : (n/1024/1024).toFixed(1)+' МБ';
function fmtTime(v){if(v==null || !Number.isFinite(Number(v)))return '—';let n=Math.max(0,Math.round(Number(v)));return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')}
function fmtEta(n){return n==null?'—':Number(n)<60?'< 1 мин':'≈ '+Math.ceil(Number(n)/60)+' мин'}
function toast(text,error=false){const el=$('toast');el.textContent=text;el.classList.toggle('error',!!error);el.classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4900)}
async function api(endpoint,opts={}){let response=await fetch('/api/'+endpoint,{cache:'no-store',...opts});let data;try{data=await response.json()}catch{throw Error('Не удалось получить ответ локального TRELLIS')}if(!response.ok)throw Error(data?.error||'Ошибка локального сервера');return data}
const post=(endpoint,data)=>api(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function show(id,visible){$(id).classList.toggle('hidden',!visible)}
function mode(){if(state.view==='settings')return 'settings';if(state.job?.status==='running')return 'generating';if(state.job?.status==='done')return 'result';return state.imageFile?'loaded':'empty'}
function showView(view){state.view=view;render();if(view==='library')refreshHistory();if(view==='settings'&&!state.local)toast('Пути к TRELLIS сохраняются только в локальной версии')}
function render(){
  let m=mode();
  document.querySelector('.main-card').classList.toggle('settings-open',state.view==='settings');
  all('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));
  ['empty-upload','loaded-upload','hero-generating','result-media'].forEach(id=>show(id,false));
  ['summary-empty','progress-card','summary-result','advanced-settings'].forEach(id=>show(id,false));
  ['side-studio','side-progress','side-result','settings-panel','side-library'].forEach(id=>show(id,false));
  if(state.view==='library'){
    show('side-library',true);
  }else if(state.view==='settings'){
    show('settings-panel',true);show('advanced-settings',true);
  }else if(m==='generating'){
    show('side-progress',true);show('progress-card',true);
  }else if(m==='result'){
    show('side-result',true);show('summary-result',true);
  }else{
    show('side-studio',true);show('summary-empty',true);
  }
  if(m==='generating' && state.view==='studio')show('hero-generating',true);
  else if(m==='result' && state.view==='studio')show('result-media',true);
  else if(state.imageFile)show('loaded-upload',true);
  else show('empty-upload',true);
  show('generate-btn',!!state.imageFile && !state.job?.status?.includes('running') && state.view==='studio');
  $('empty-title').textContent=state.imageFile?'Из картинки — в 3D.':'Новая 3D-модель';
  $('connection-text').textContent=state.local?'Локально · FP16':'Веб-интерфейс';
  document.querySelector('.online-dot').classList.toggle('online',state.local);
  show('public-help',!state.local && state.view==='studio');
  $('installation-status').textContent=state.local?'✓ Локальный сервер':'○ Нужен TRELLIS';
  $('installation-status').classList.toggle('verified',state.local);
  $('path-summary').textContent=state.settingSnapshot?.trellis_path||'Локальный TRELLIS · FP16';
}
function fields(){return {
  ss_steps:Number($('ss_steps').value),slat_steps:Number($('slat_steps').value),
  ss_guidance:Number($('ss_guidance').value),slat_guidance:Number($('slat_guidance').value),
  seed:Number($('seed').value)||0,random_seed:$('random_seed').checked,
  texture_size:Number($('texture_size').value),simplify:Number($('simplify').value),
  export_glb:$('export_glb').checked,export_ply:$('export_ply').checked
}}
function fieldValues(settings){if(!settings)return;for(const id of ['ss_steps','slat_steps','ss_guidance','slat_guidance','seed','texture_size','simplify','trellis_path','output_path']){if(settings[id]!=null)$(id).value=settings[id]};for(const id of ['random_seed','export_glb','export_ply']){if(settings[id]!=null)$(id).checked=!!settings[id]};$('seed').disabled=$('random_seed').checked;syncPresets();syncTexture()}
function preset(name){const v=PRESETS[name];if(!v)return;for(const [id,val]of Object.entries(v))$(id).value=val;state.selectedPreset=name;syncPresets();syncTexture()}
function syncPresets(){let found=Object.keys(PRESETS).find(p=>PRESETS[p].ss_steps===Number($('ss_steps').value)&&PRESETS[p].slat_steps===Number($('slat_steps').value)&&PRESETS[p].texture_size===Number($('texture_size').value));state.selectedPreset=found||'custom';all('[data-preset]').forEach(b=>{b.classList.toggle('active',b.dataset.preset===found);b.classList.toggle('selected',b.dataset.preset===found)})}
function syncTexture(){all('[data-texture]').forEach(b=>b.classList.toggle('active',Number(b.dataset.texture)===Number($('texture_size').value)))}
all('[data-preset]').forEach(btn=>btn.addEventListener('click',()=>preset(btn.dataset.preset)));
all('[data-texture]').forEach(btn=>btn.addEventListener('click',()=>{$('texture_size').value=btn.dataset.texture;syncTexture();syncPresets()}));
['ss_steps','slat_steps','texture_size'].forEach(id=>$(id).addEventListener('change',syncPresets));
$('random_seed').addEventListener('change',()=>{$('seed').disabled=$('random_seed').checked});
function validateFile(file){if(!file)throw Error('Выберите изображение');if(!/\.(png|jpe?g|webp)$/i.test(file.name) || !['image/png','image/jpeg','image/webp',''].includes(file.type))throw Error('Поддерживаются PNG, JPG и WEBP');if(file.size>24*1024*1024)throw Error('Максимальный размер файла — 24 МБ')}
async function upload(file){
  try{validateFile(file);if(state.job?.status==='running')throw Error('Сначала остановите текущую генерацию');
    if(state.local){const data=await api('upload',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});state.imageId=data.image_id}else{state.imageId=null}
    if(state.imageURL)URL.revokeObjectURL(state.imageURL);state.imageURL=URL.createObjectURL(file);
    state.imageFile=file;state.job=null;state.waitingToStart=true;state.historyMode=false;state.view='studio';$('uploaded-image').src=state.imageURL;$('image-name').textContent=file.name;$('image-meta').textContent=filesize(file.size)+' · Изображение';render();toast(state.local?'Изображение загружено':'Фото готово к просмотру. Для генерации нужен локальный TRELLIS.');
  }catch(e){toast(e.message,true)}
}
$('image-input').addEventListener('change',event=>{upload(event.target.files?.[0]);event.target.value=''});
$('choose-image').addEventListener('click',event=>{event.stopPropagation();$('image-input').click()});
$('replace-image').addEventListener('click',event=>{event.stopPropagation();$('image-input').click()});
$('dropzone').addEventListener('click',event=>{if(state.job?.status==='running'||event.target.closest('button,a,video,model-viewer'))return;if(!state.imageFile||!state.job)$('image-input').click()});
$('dropzone').addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!state.job?.status?.includes('running')){event.preventDefault();$('image-input').click()}});
$('dropzone').addEventListener('dragover',event=>{event.preventDefault();$('dropzone').classList.add('dragover')});
$('dropzone').addEventListener('dragleave',()=>{$('dropzone').classList.remove('dragover')});
$('dropzone').addEventListener('drop',event=>{event.preventDefault();$('dropzone').classList.remove('dragover');upload(event.dataTransfer?.files?.[0])});

async function start(){
  if(!state.local){showView('studio');$('public-help').scrollIntoView({behavior:'smooth',block:'nearest'});toast('GitHub Pages не может запустить TRELLIS. Откройте локальный сайт на ПК.',true);return}
  if(!state.imageId){$('image-input').click();toast('Сначала загрузите фотографию');return}
  if(state.job?.status==='running')return;
  if(!fields().export_glb&&!fields().export_ply){showView('settings');toast('Выберите GLB или PLY',true);return}
  try{
    const job=await post('start',{image_id:state.imageId,settings:fields()});
    state.job={id:job.id,status:'running',stage:'loading',message:'Запускаем TRELLIS',stage_number:1,elapsed_sec:0,eta_sec:null,seed:job.seed,logs:[]};state.historyMode=false;state.waitingToStart=false;state.lastJobStatus='running';state.view='studio';render();updateJob(state.job);
  }catch(e){toast(e.message,true);if(e.message.includes('TRELLIS'))showView('settings')}
}
$('generate-btn').addEventListener('click',start);$('settings-generate').addEventListener('click',start);
$('cancel-btn').addEventListener('click',async()=>{if(!state.local)return;try{await post('cancel',{});toast('Останавливаем генерацию…')}catch(e){toast(e.message,true)}});
$('expand-params').addEventListener('click',()=>showView('settings'));
$('settings-return').addEventListener('click',()=>showView('studio'));
$('settings-btn').addEventListener('click',()=>showView('settings'));
all('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
$('open-library').addEventListener('click',()=>showView('library'));
$('library-back').addEventListener('click',()=>showView('studio'));
$('manual-settings').addEventListener('click',()=>{$('advanced-settings').querySelector('details').open=true;toast('Дополнительные параметры раскрыты в левой карточке')});
$('result-edit-settings').addEventListener('click',()=>showView('settings'));
$('new-image').addEventListener('click',()=>{$('image-input').click()});
$('result-retry').addEventListener('click',()=>{$('image-input').click();toast('Выберите изображение для нового варианта')});
$('progress-retry').addEventListener('click',()=>toast('Для нового варианта сначала остановите текущую генерацию'));
$('progress-preview').addEventListener('click',()=>toast('Превью доступно после завершения генерации'));
$('save-library').addEventListener('click',()=>{showView('library');toast('Успешные генерации автоматически сохраняются в библиотеке')});
$('share-result').addEventListener('click',()=>toast('Модель хранится на вашем ПК. Для передачи скачайте GLB или PLY.'));
all('[data-demo-card]').forEach(b=>b.addEventListener('click',()=>toast('Это пример карточки из макета. Ваши модели появятся после генерации.')));
$('reset-preset').addEventListener('click',()=>{preset('economy');$('random_seed').checked=true;$('seed').disabled=true;$('export_glb').checked=true;$('export_ply').checked=false;toast('Настройки сброшены к экономному режиму')});
$('save-preset').addEventListener('click',()=>{try{localStorage.setItem('sredstvo-preset',JSON.stringify(fields()));toast('Параметры сохранены в этом браузере')}catch{toast('Браузер запретил сохранение параметров',true)}});
for(const btn of all('.browse-btn[data-target]'))btn.addEventListener('click',async()=>{try{if(window.pywebview?.api?.pick_folder){const chosen=await window.pywebview.api.pick_folder();if(chosen)$(btn.dataset.target).value=chosen}else toast('Введите путь вручную: браузер не имеет доступа к папкам ПК')}catch{toast('Укажите папку вручную',true)}});
$('save-settings').addEventListener('click',async()=>{if(!state.local){toast('Сохранение путей доступно только в локальном TRELLIS',true);return}try{state.settingSnapshot=await post('settings',{trellis_path:$('trellis_path').value,output_path:$('output_path').value});toast('Пути сохранены');render()}catch(e){toast(e.message,true)}});
$('verify-install').addEventListener('click',()=>toast(state.local?'Сервер запущен. Проверка модели произойдёт при генерации.':'Откройте локальную версию TRELLIS',!state.local));
$('logs-toggle').addEventListener('click',()=>{show('logs',$('logs').classList.contains('hidden'));$('logs').scrollIntoView({behavior:'smooth',block:'nearest'})});
$('progress-notify').addEventListener('click',async()=>{if(!('Notification' in window)){toast('Уведомления недоступны в этом браузере');return}const result=await Notification.requestPermission();state.notifyOnFinish=result==='granted';toast(state.notifyOnFinish?'Уведомим, когда генерация закончится':'Браузер не разрешил уведомления')});

let viewerPromise;
function ensureViewer(){if(customElements.get('model-viewer'))return Promise.resolve();if(!viewerPromise){viewerPromise=new Promise((resolve,reject)=>{const s=document.createElement('script');s.type='module';s.src='https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js';s.onload=()=>customElements.whenDefined('model-viewer').then(resolve,reject);s.onerror=()=>reject(Error('3D-компонент недоступен'));document.head.appendChild(s);setTimeout(()=>reject(Error('3D-компонент не загрузился')),12000)})}return viewerPromise}
function switchMedia(use3d){state.view3d=!!use3d;let hasVideo=!!state.job?.files?.preview,has3d=!!state.job?.files?.glb;show('viewer-placeholder',false);show('preview-video',!use3d&&hasVideo);show('model-view',use3d&&has3d);$('show-video').classList.toggle('selected',!use3d);$('show-3d').classList.toggle('selected',use3d);if(!use3d&&hasVideo)$('preview-video').play().catch(()=>{});else $('preview-video').pause()}
$('show-video').addEventListener('click',()=>switchMedia(false));
$('show-3d').addEventListener('click',async()=>{if(!state.job?.files?.glb){toast('Экспорт GLB не был выбран');return}try{await ensureViewer();switchMedia(true)}catch(e){toast('3D-плеер недоступен без интернета; видео 360° работает локально',true);switchMedia(false)}});
$('reset-view').addEventListener('click',()=>{if(state.view3d){$('model-view').resetTurntableRotation?.()}else $('preview-video').currentTime=0});
$('fullscreen-view').addEventListener('click',()=>{$('result-media').requestFullscreen?.().catch(()=>toast('Полноэкранный режим недоступен'))});
function filesFor(job){let id=encodeURIComponent(job.id);return {glb:`/files/${id}/model.glb`,ply:`/files/${id}/model.ply`,preview:`/files/${id}/preview.mp4`}}
function success(job){
  if(!job?.files)return;
  let urls=filesFor(job),files=job.files;
  $('result-seed').textContent=String(job.seed??'—');$('result-params-seed').textContent=String(job.seed??'—');
  $('result-texture').textContent=Number($('texture_size').value)+' px';$('result-params-texture').textContent=Number($('texture_size').value)+' px';
  $('result-params-export').textContent=[files.glb?'GLB':null,files.ply?'PLY':null].filter(Boolean).join(' · ')||'Видео';
  $('duration-text').textContent=job.elapsed_sec!=null?`Готово за ${fmtTime(job.elapsed_sec)}`:'Генерация завершена';
  $('result-size').textContent=files.glb?'GLB':files.ply?'PLY':'Видео';
  $('viewer-label').textContent=files.glb?'Готовая модель':'Превью';
  $('downloads-list').replaceChildren();
  for(const kind of ['glb','ply','preview'])if(files[kind]){
    let row=document.createElement('div');row.className='file-row';let icon=document.createElement('span');icon.className='file-icon';icon.textContent=kind==='preview'?'▣':'⬡';let info=document.createElement('div');let title=document.createElement('strong');title.textContent=FORMAT[kind][0];let details=document.createElement('small');details.textContent=FORMAT[kind][1];info.append(title,details);let link=document.createElement('a');link.href=urls[kind];link.setAttribute('download',FORMAT[kind][0]);link.textContent='↓ Скачать';row.append(icon,info,link);$('downloads-list').append(row)
  }
  let mainKind=files.glb?'glb':files.ply?'ply':'preview';let main=$('download-primary');main.href=urls[mainKind];main.setAttribute('download',FORMAT[mainKind][0]);main.textContent=`↓  Скачать ${mainKind.toUpperCase()}`;
  $('download-ply-short').disabled=!files.ply;
  $('download-ply-short').onclick=()=>{if(files.ply)window.location.href=urls.ply};
  if(files.preview){$('preview-video').src=urls.preview;$('preview-video').load()}
  if(files.glb)$('model-view').setAttribute('src',urls.glb);
  show('show-3d',!!files.glb);show('show-video',!!files.preview);
  if(files.preview)switchMedia(false);else if(files.glb){show('viewer-placeholder',true);$('show-3d').click()}else show('viewer-placeholder',true);
  $('open-folder').dataset.id=job.id;$('result-open-folder').dataset.id=job.id;
  state.view='studio';render();
}
async function openFolder(){if(!state.local||!state.job?.id){toast('Папка доступна только в локальной версии');return}try{await post('open-folder',{id:state.job.id})}catch(e){toast(e.message,true)}}
$('open-folder').addEventListener('click',openFolder);$('result-open-folder').addEventListener('click',openFolder);
function updateJob(job){
  if(!job)return;const prev=state.job?.status;state.job=job;
  if(job.status==='running'){
    const idx=Math.max(0,STAGES.indexOf(job.stage));
    $('hero-stage-num').textContent=`ЭТАП ${idx+1}/4`;
    $('hero-generation-label').textContent=STAGE_NAMES[job.stage]||'Генерация 3D';
    $('hero-generation-hint').textContent=STAGE_HINTS[job.stage]||job.message||'TRELLIS обрабатывает изображение';
    $('progress-stage-label').textContent=`Этап ${idx+1} из 4 · ${STAGE_NAMES[job.stage]||'Обработка'}`;
    $('progress-percent').textContent=`${idx+1}/4`;
    $('progress-desc').textContent=job.message||STAGE_HINTS[job.stage];
    $('progress-fill').style.width=((idx+1)/4*100)+'%';
    $('elapsed').textContent=fmtTime(job.elapsed_sec);
    $('eta').textContent=fmtEta(job.eta_sec);
    $('total-estimate').textContent=job.eta_sec!=null?`Осталось ${fmtEta(job.eta_sec)}`:'Оценка после первого запуска';
    all('#stage-dots i').forEach((d,i)=>{d.classList.toggle('done',i<idx);d.classList.toggle('active',i===idx)});
    all('[data-stage]').forEach((row,i)=>{row.classList.toggle('done',i<idx);row.classList.toggle('active',i===idx);let v=row.querySelector('i'),t=row.querySelector('small');v.textContent=i<idx?'✓':i===idx?'✣':'○';t.textContent=i<idx?'готово':i===idx?'идёт':'—'});
    $('log-preview').textContent=(job.logs||[]).slice(-6).join('\n')||'Ожидание сообщений TRELLIS…';
    $('logs').textContent=(job.logs||[]).join('\n');
    if(state.view==='studio')render();
  }else if(job.status==='done'){
    if(prev!=='done'){
      success(job);refreshHistory();if(state.notifyOnFinish&&typeof Notification!=='undefined'&&Notification.permission==='granted')new Notification('TRELLIS: 3D-модель готова!');
    }
  }else if(job.status==='error'||job.status==='cancelled'){
    $('logs').textContent=(job.logs||[]).join('\n')+'\n'+(job.error||'');
    $('log-preview').textContent=(job.logs||[]).slice(-8).join('\n')||job.message;
    if(state.view==='studio')render();
    if(prev==='running')toast(job.status==='error'?'Ошибка TRELLIS. Откройте журнал.':'Генерация остановлена.',job.status==='error');
    show('logs',job.status==='error');
  }
}
async function refreshStatus(){if(!state.local||state.historyMode||state.waitingToStart)return;try{let job=await api('status');if(job)updateJob(job)}catch(e){/* local service can be closing */}}
function rowFor(job){
  let row=document.createElement('div');row.className='recent-row';
  let ico=document.createElement('span');ico.className='recent-icon';ico.textContent=job.files?.glb?'⬡':job.status==='done'?'▣':'◷';
  let info=document.createElement('div');info.className='recent-info';let title=document.createElement('strong');title.textContent='Модель '+job.id.split('-').slice(0,2).join(' · ');let sub=document.createElement('small');sub.textContent=(job.status==='done'?'GLB / PLY · ':job.status==='error'?'Ошибка · ':'Остановлено · ')+fmtTime((job.finished_at||job.started_at)-job.started_at);info.append(title,sub);
  let btn=document.createElement('button');btn.type='button';btn.textContent=job.status==='done'?'Открыть':'Журнал';btn.addEventListener('click',()=>{
    if(job.status==='done'){state.historyMode=true;state.job={...job,elapsed_sec:Math.round((job.finished_at||job.started_at)-job.started_at)};success(state.job)}else toast('Подробности ошибки можно посмотреть в локальной студии')
  });row.append(ico,info,btn);return row;
}
async function refreshHistory(){
  if(!state.local)return;
  try{const jobs=await api('history');state.history=Array.isArray(jobs)?jobs:[];for(const id of ['history-items','library-items']){let panel=$(id);panel.replaceChildren();if(!state.history.length){let p=document.createElement('p');p.className='empty-library';p.textContent='Здесь появятся ваши модели после первой генерации.';panel.append(p)}else for(const job of state.history.slice(0,id==='library-items'?60:4))panel.append(rowFor(job))}}
  catch(e){/* history is optional */}
}
(async function init(){
  render();
  if(state.local){try{state.settingSnapshot=await api('settings');fieldValues(state.settingSnapshot);try{const saved=localStorage.getItem('sredstvo-preset');if(saved)fieldValues(JSON.parse(saved))}catch{}render();await refreshHistory();await refreshStatus()}catch(e){state.local=false;render();toast('Локальный сервер TRELLIS не отвечает',true)}setInterval(refreshStatus,1500)}
})();
