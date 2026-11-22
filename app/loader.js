'use strict';
const $=id=>document.getElementById(id);
const ENGINE='recomp-g2v15';
const DEBUG=true;

function dbg(msg,color){
  if(!DEBUG)return;
  const box=$('debuglog');
  box.style.display='block';
  const d=document.createElement('div');
  d.style.color=color||'#9fe6b0';
  d.textContent=msg;
  box.appendChild(d);
  box.scrollTop=box.scrollHeight;
}

function showBoot(t){const b=$('booting');if(b){b.classList.remove('hidden');const p=b.querySelector('.boot-phase');if(p)p.textContent=t||'Starting…'}}
function hideBoot(){const b=$('booting');if(b)b.classList.add('hidden')}

function sizeCanvas(){
  const c=$('canvas'),r=c.getBoundingClientRect();
  const k=Math.min(devicePixelRatio||1,2);
  c.width=Math.round(r.width*k);c.height=Math.round(r.height*k);
}

async function run(){
  dbg('=== PLAY pressed ===');
  const touch=matchMedia('(pointer:coarse)').matches;
  $('panel').classList.add('hidden');
  document.body.classList.add('playing');
  showBoot('Loading engine…');
  sizeCanvas();
  window.RC_RENDERER='gl';

  // 1. Load engine JS
  dbg('Loading build/'+ENGINE+'.js');
  const s=document.createElement('script');
  s.src='build/'+ENGINE+'.js';
  s.onerror=()=>{hideBoot();$('panel').classList.remove('hidden');$('status').textContent='ERROR: Engine file not found (build/'+ENGINE+'.js). Make sure it is in the app/build/ folder.';dbg('Engine JS FAILED to load','#ff8b8b');return};
  s.onload=()=>{
    dbg('Engine JS loaded. createRecomp: '+typeof createRecomp);
    if(typeof createRecomp!=='function'){hideBoot();$('panel').classList.remove('hidden');$('status').textContent='ERROR: createRecomp not defined after loading engine.';dbg('createRecomp not a function!','#ff8b8b');return}
    startEngine(touch);
  };
  document.head.appendChild(s);
}

async function startEngine(touch){
  try{
    showBoot('Starting game…');
    dbg('Calling createRecomp…');
    const M=await createRecomp({
      arguments:['/game'],
      print:t=>dbg('[engine] '+t),
      printErr:t=>dbg('[engine-err] '+t,'#ff8b8b'),
      preRun:[m=>{m.ENV.RC_MEM_COMPACT='1'}]
    });
    dbg('createRecomp done');

    const c=$('canvas');
    showBoot('Initializing graphics…');
    const ok=M._rc_gl_init(c.width,c.height);
    if(!ok)throw new Error('WebGL 2 init failed');
    dbg('WebGL 2 OK: '+c.width+'x'+c.height);

    // Input
    const HID={};
    for(let i=0;i<26;i++)HID['Key'+String.fromCharCode(65+i)]=4+i;
    for(let i=1;i<=9;i++)HID['Digit'+i]=29+i;
    HID.Digit0=39;
    Object.assign(HID,{Enter:40,Escape:41,Backspace:42,Tab:43,Space:44,Minus:45,Equal:46,
      BracketLeft:47,BracketRight:48,Backslash:49,Semicolon:51,Quote:52,Backquote:53,
      Comma:54,Period:55,Slash:56,CapsLock:57,ArrowRight:79,ArrowLeft:80,ArrowDown:81,ArrowUp:82,
      ControlLeft:224,ShiftLeft:225,AltLeft:226,ControlRight:228,ShiftRight:229,AltRight:230});
    for(let i=1;i<=12;i++)HID['F'+i]=57+i;
    for(let i=1;i<=9;i++)HID['Numpad'+i]=88+i;

    const held=new Set();
    window.addEventListener('keydown',e=>{const u=HID[e.code];if(u!==undefined){e.preventDefault();if(!e.repeat){held.add(u);M._input_key_hid(u,1)}}});
    window.addEventListener('keyup',e=>{const u=HID[e.code];if(u!==undefined){held.delete(u);M._input_key_hid(u,0)}});
    window.addEventListener('blur',()=>{held.forEach(u=>M._input_key_hid(u,0));held.clear()});
    c.addEventListener('mousedown',e=>{try{c.requestPointerLock?.()}catch{};M._input_mouse_button(e.button,1)});
    window.addEventListener('mouseup',e=>M._input_mouse_button(e.button,0));
    c.addEventListener('mousemove',e=>M._input_mouse_move(e.movementX,e.movementY));
    c.addEventListener('wheel',e=>{e.preventDefault();M._input_mouse_wheel(e.deltaY>0?1:-1)},{passive:false});
    c.addEventListener('contextmenu',e=>e.preventDefault());

    // Touch
    if(typeof RcTouch!=='undefined'&&touch){RcTouch.attach(M,$('stage'),c);dbg('Touch attached')}

    // LAN
    if(typeof RcLan!=='undefined')RcLan.attach(M);

    // Audio
    try{
      const ctx=new AudioContext({sampleRate:44100});
      await ctx.audioWorklet.addModule('audio-worklet.js');
      const node=new AudioWorkletNode(ctx,'rc-ring',{outputChannelCount:[2]});
      node.port.postMessage({memory:M.wasmMemory,ring:M._rc_audio_ring()});
      node.connect(ctx.destination);ctx.resume();
      dbg('Audio OK');
    }catch(e){dbg('Audio: '+e.message,'#ff8b8b')}

    // Frame loop
    dbg('Frame loop starting…');
    let booted=false,frames=0,lastP=0;
    const frame=t=>{
      const n=M._rc_gpu_pump(1);
      if(n){lastP=t;if(!booted){frames+=n;if(frames>=24){booted=true;hideBoot();dbg('=== GAME RUNNING ===')}}}
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setInterval(()=>M._rc_gpu_pump(0),8);
    c.focus();

  }catch(e){
    hideBoot();
    $('panel').classList.remove('hidden');
    $('status').textContent='ERROR: '+(e.message||e);
    dbg('RUN ERROR: '+e.message+'\n'+e.stack,'#ff8b8b');
  }
}

// Select Game Folder
$('pick').onclick=()=>{
  $('status').textContent='Game files (app/game/) APK ke andar hote hain. Play dabao – agar files nahi hain toh engine khud error dega.';
  dbg('Note: game files must be in app/game/ folder inside the APK');
};   

// Play
$('play').onclick=()=>run();

// Reset
$('reset').onclick=e=>{e.preventDefault();location.reload()};

// Fullscreen
$('fs').onclick=()=>{
  const s=$('stage');
  if(document.fullscreenElement)document.exitFullscreen();
  else s.requestFullscreen?.()||s.webkitRequestFullscreen?.();
};

// Device toggle
document.querySelectorAll('#device button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#device button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  document.body.classList.toggle('coarse',b.dataset.device==='touch');
});

dbg('=== LOADER LOADED – Ready ===');
dbg('URL: '+location.href);   
