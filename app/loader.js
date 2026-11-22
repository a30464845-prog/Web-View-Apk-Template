'use strict';
const $=id=>document.getElementById(id);
const ENGINE='recomp-g2v15';

function showBoot(){const b=$('booting');if(b)b.classList.remove('hidden')}
function hideBoot(){const b=$('booting');if(b)b.classList.add('hidden')}

function sizeCanvas(){
  const c=$('canvas'),r=c.getBoundingClientRect();
  const k=Math.min(devicePixelRatio||1,2);
  c.width=Math.round(r.width*k);c.height=Math.round(r.height*k);
}

async function run(){
  const touch=matchMedia('(pointer:coarse)').matches;
  $('panel').classList.add('hidden');
  document.body.classList.add('playing');
  showBoot();
  sizeCanvas();
  window.RC_RENDERER='gl';

  // Load engine
  const s=document.createElement('script');
  s.src='build/'+ENGINE+'.js';
  await new Promise((res,rej)=>{s.onload=res;s.onerror=()=>rej(new Error('Engine not found'));document.head.appendChild(s)});
  if(typeof createRecomp!=='function') throw new Error('createRecomp not defined');

  const M=await createRecomp({
    arguments:['/game'],
    print:t=>console.log(t),
    printErr:t=>console.error(t),
    preRun:[m=>{m.ENV.RC_MEM_COMPACT='1'}]
  });

  const c=$('canvas');
  if(!M._rc_gl_init(c.width,c.height)) throw new Error('WebGL2 failed');

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

  window.addEventListener('keydown',e=>{const u=HID[e.code];if(u!==undefined){e.preventDefault();M._input_key_hid(u,1)}});
  window.addEventListener('keyup',e=>{const u=HID[e.code];if(u!==undefined)M._input_key_hid(u,0)});
  c.addEventListener('mousedown',e=>M._input_mouse_button(e.button,1));
  window.addEventListener('mouseup',e=>M._input_mouse_button(e.button,0));
  c.addEventListener('mousemove',e=>M._input_mouse_move(e.movementX,e.movementY));
  c.addEventListener('wheel',e=>{e.preventDefault();M._input_mouse_wheel(e.deltaY>0?1:-1)},{passive:false});
  c.addEventListener('contextmenu',e=>e.preventDefault());

  if(typeof RcTouch!=='undefined'&&touch)RcTouch.attach(M,$('stage'),c);
  if(typeof RcLan!=='undefined')RcLan.attach(M);

  // Audio
  try{
    const ctx=new AudioContext({sampleRate:44100});
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const node=new AudioWorkletNode(ctx,'rc-ring',{outputChannelCount:[2]});
    node.port.postMessage({memory:M.wasmMemory,ring:M._rc_audio_ring()});
    node.connect(ctx.destination);ctx.resume();
  }catch(e){console.warn('audio:',e.message)}

  // Frame loop
  let booted=false,frames=0,lastP=0;
  const frame=t=>{
    const n=M._rc_gpu_pump(1);
    if(n){lastP=t;if(!booted){frames+=n;if(frames>=24){booted=true;hideBoot()}}}
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(()=>M._rc_gpu_pump(0),8);
  c.focus();
}

// Play button
$('play').onclick=()=>run().catch(e=>{
  hideBoot();
  $('panel').classList.remove('hidden');
  $('view-home').classList.remove('hidden');
  $('status').textContent='Error: '+e.message;
});
$('reset').onclick=()=>location.reload();
$('fs').onclick=()=>{
  const s=$('stage');
  if(document.fullscreenElement)document.exitFullscreen();
  else s.requestFullscreen?.()||s.webkitRequestFullscreen?.();
};
document.querySelectorAll('#device button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#device button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  document.body.classList.toggle('coarse',b.dataset.device==='touch');
});   
